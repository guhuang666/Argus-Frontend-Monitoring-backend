import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { WorkerMetricsService } from '../metrics/worker-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DLQ_JOB_OPTIONS,
  ERROR_EVENT_DLQ,
  ERROR_EVENT_JOB,
  ERROR_EVENT_QUEUE,
  jobEventIds,
  toJobId,
  type ErrorEventDlqData,
  type ErrorEventJobData,
} from '../queue/queue.constants';
import {
  buildCulprit,
  buildTitle,
  computeFingerprint,
  GROUPING_VERSION_RAW,
  GROUPING_VERSION_SYMBOLICATED,
  parseFrames,
} from './fingerprint';
import { toHourBucket } from './issue-stats';
import { SourcemapLookupService } from './sourcemap-lookup.service';
import {
  buildSymbolicatedCulprit,
  computeSymbolicatedFingerprint,
} from './symbolicate';

/** 消费日志里 message 的截断长度：日志是扫一眼用的，整段 stack 不该进日志 */
const LOG_MESSAGE_LIMIT = 120;

/** 被声明下来的那条事件（UPDATE ... RETURNING 的返回行） */
interface ClaimedEvent {
  event_id: string;
  mechanism: string;
  type: string;
  message: string;
  /** 整段栈原文。算指纹与解析 frames 都要用，所以必须跟着 RETURNING 回来 */
  stack: string | null;
  /** 事件发生时间（客户端时钟），作为 first_seen / last_seen 的来源 */
  timestamp: Date;
  /**
   * 上报时带的版本号，如 `web@1.4.2`。可空 —— SDK 允许不配版本。
   *
   * M3 起它是 Worker 找 Sourcemap 的**唯一坐标**（FR-3.4：按 release 匹配）。
   * 少这一列不会报错，只会让符号化在第一步就以"查不到版本"的名义降级掉，
   * 表现是看板上永远是"未符号化" —— 所以它必须跟着 RETURNING 回来。
   */
  release: string | null;
  /**
   * 所属项目（S0 多租户）。**必须跟着 RETURNING 回来**：upsert error_groups
   * 的唯一键是 (project_id, grouping_version, fingerprint)，少了它就只能按
   * 全局归并 —— 两个项目的同名错误会被并成一个问题。
   */
  project_id: string;
  /**
   * 运行环境（M5 / FR-8.3）：production / staging / local。可空 —— SDK 允许不配。
   *
   * **必须跟着 RETURNING 回来**：它要写进 `error_groups.last_environment`，
   * 也就是问题列表按环境筛选的唯一依据。漏掉不会报错，只会让筛选永远命中不到。
   */
  environment: string | null;
  /**
   * 触发这条事件的用户（M5 / FR-4.4）：账号 ID 或匿名设备 ID，SDK 拿不到身份时 NULL。
   *
   * **同样必须跟着 RETURNING 回来**：它只用于写 affected_users 去重表。
   * 漏掉这一列不会报任何错 —— 表现是 users_seen 永远停在 0，只能从看板上发现。
   */
  user_id: string | null;
}

/** claim() 的产出：声明到的事件 + 归并结果（给日志用） */
interface ClaimOutcome {
  event: ClaimedEvent;
  fingerprint: string;
  groupId: string;
  timesSeen: bigint;
  /** 这条走的是 v2-symbolicated 还是退回 v1-raw —— 验收时一眼能看出符号化有没有生效 */
  symbolicated: boolean;
}

/** claimMany() 的产出汇总，只用于一行日志 */
interface BatchOutcome {
  /** 真正抢到并归并的条数 */
  claimed: number;
  /** 没抢到（重复投递 / 事件不存在）的条数 */
  skipped: number;
  /** 本批落到几个问题（指纹）上 */
  groups: number;
  /** 其中多少条走了 v2-symbolicated */
  symbolicated: number;
  /** 每个问题归并后的 times_seen，用于验收「批量累加对不对」 */
  timesSeenByGroup: string[];
}

/** 一个指纹桶：本批里所有归到同一问题的事件 */
interface FingerprintBucket {
  projectId: string;
  groupingVersion: string;
  fingerprint: string;
  title: string;
  /**
   * 出错位置。`buildCulprit()` 在栈里找不到可用帧时会返回 null ——
   * error_groups.culprit 本身可空，这里的类型必须跟着放宽，
   * 否则这桶会被当成"类型不匹配"而落不进 Map。
   */
  culprit: string | null;
  /** 归并成功后回填的 group id */
  groupId?: string;
  items: Array<{ event: ClaimedEvent; framesToStore: unknown[] }>;
}

/**
 * 归并 Worker 的消费逻辑（W3 骨架 + W4 归并；M4-S7 起不再自己挂 Worker）。
 *
 * ── 它现在做什么 ────────────────────────────────────────────────────────
 * 处理一条 `error-event` job，在**一个事务里**做两件事：
 *   ① 把 error_events.processed_at 从 NULL 原子置位 —— 抢到的那次才继续
 *   ② 算指纹 → upsert error_groups → 回填 error_events.group_id
 * 置位成功 = 这条事件归我处理；置位失败 = 别人（或上一次的自己）已经处理过。
 *
 * ── S7 为什么去掉了 @Processor 装饰器 ────────────────────────────────────
 * `@Processor('error-events')` 只能绑**一个固定队列名**，而 S7 要给每个项目
 * 建一条 `error-events-<projectId>`。所以这里退化成纯粹的"处理一条 job"，
 * 由 `ProjectWorkerManager` 按项目创建 Worker，并把 job 递进来。
 *
 * 好处是消费逻辑和"监听谁"解耦了：以后再加队列（比如性能指标单独一条），
 * 只要把 job 递进 `handle()` 就行，归并逻辑一行都不用改。
 *
 * ── 为什么归并必须和声明在同一个事务里 ──────────────────────────────────
 * **不要**把归并挪到事务外面：一旦归并抛错要重试，重试会在声明那一步看到
 * processed_at 已置位而被自己的闸门挡在门外 —— 事件永久丢失，而且不报错，
 * 只在 debug 日志里留一句"已处理过"。放进事务里，回滚会把闸门一起撤销，
 * 重试才有机会重做。
 */
@Injectable()
export class ErrorEventProcessor {
  private readonly logger = new Logger(ErrorEventProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ERROR_EVENT_DLQ)
    private readonly dlq: Queue<ErrorEventDlqData>,
    private readonly sourcemaps: SourcemapLookupService,
    // 指标（M6-7）：只登记"进了死信"这一件事。
    // 成功/失败的计数在 ProjectWorkerManager 上挂（那里是所有 Worker 的创建点）
    private readonly metrics: WorkerMetricsService,
  ) {}

  /**
   * 处理一条事件。
   *
   * 抛异常 = 这次尝试失败，BullMQ 按 ERROR_EVENT_JOB_OPTIONS 的退避策略重试，
   * 3 次用尽后由 onFailed 转 DLQ。所以这里"该抛就抛"：DB 短暂不可用就应该重试，
   * 不要自己吞掉错误假装成功 —— 吞掉等于永久丢失这条事件的归并。
   */
  async handle(job: Job<ErrorEventJobData>): Promise<void> {
    const eventIds = jobEventIds(job.data);
    const requestId = job.data.requestId;

    if (eventIds.length === 0) {
      this.logger.warn(`job 载荷里没有事件主键，跳过: jobId=${job.id ?? '-'}`);
      return;
    }

    // ── 老 job 兼容（M7-T5 之前投递的）──────────────────────────────
    // 它们的载荷只有 `eventId`。这些 job 跑完就再也不会产生了，
    // 所以保留原来那条逐条路径，不改动它 —— 改造期间队列里可能还压着它们。
    if (job.data.eventIds === undefined) {
      const outcome = await this.claim(eventIds[0]);

      if (outcome === null) {
        await this.explainUnclaimed(eventIds[0], requestId);
        return;
      }

      const { event, fingerprint, groupId, timesSeen, symbolicated } = outcome;
      this.logger.log(
        `已消费 event_id=${eventIds[0]} requestId=${requestId ?? '-'} ` +
          `group=${groupId.slice(0, 8)} ` +
          `fp=${fingerprint.slice(0, 8)} times=${timesSeen} ` +
          `ver=${symbolicated ? 'v2' : 'v1'} ` +
          `mechanism=${event.mechanism} type=${event.type} ` +
          `message="${truncate(event.message, LOG_MESSAGE_LIMIT)}"`,
      );
      return;
    }

    // ── 批量路径（M7-T5）──────────────────────────────────────────────
    const summary = await this.claimMany(eventIds);

    if (summary.claimed === 0) {
      // 整批都没抢到：多半是重复投递（退场时 visibilitychange + pagehide 会发两次）
      await this.explainUnclaimed(eventIds[0], requestId);
      return;
    }

    // 一条汇总日志而不是 N 条：批量之后逐条打会把日志量放大 50 倍，
    // 而排查时真正需要的是「这一批进了几个问题、跳过几条」。
    this.logger.log(
      `已消费 ${summary.claimed}/${eventIds.length} 条 requestId=${requestId ?? '-'} ` +
        `groups=${summary.groups} skipped=${summary.skipped} ` +
        `symbolicated=${summary.symbolicated}/${summary.claimed} ` +
        `times=${summary.timesSeenByGroup.join('/')}`,
    );
  }

  /**
   * 批量声明 + 批量归并（M7-T5）。
   *
   * ── 为什么批量能提消费速率 ─────────────────────────────────────────────
   * 逐条处理时，每事件要写 4~5 条 SQL，其中**两条打在同一行 error_groups**
   * （upsert 的 times_seen +1、以及新用户时的 users_seen +1）。高并发下所有
   * 消费者都在抢这一行，行锁把本来能并行的活串行化了。
   *
   * 批量之后，N 条事件如果落进同一个指纹：
   *   声明 1 条 + upsert 1 条（times_seen += N）+ affected_users 1 条
   *   + 小时聚合 1 条 + 回填 1 条 = **5 条 SQL 处理 N 条事件**
   * 而不是 5N 条。写同一行的次数从 N 次降到 1 次 —— 这才是收益来源。
   *
   * ── 为什么仍然整批一个事务 ─────────────────────────────────────────────
   * 见类注释：归并必须和"声明"在同一个事务里，否则失败重试会被自己的闸门
   * （processed_at 已置位）挡在门外，事件永久丢失且不报错。
   *
   * ── 时间桶为什么要按时间戳做 Map key 去重 ───────────────────────────────
   * `toHourBucket()` 返回的是 Date 对象，`Date` 作为 Map 的 key 用的是**对象标识**
   * 而不是值 —— 两个内容相同的 Date 是两个不同的 key。必须用 getTime() 归一。
   */
  private async claimMany(eventIds: string[]): Promise<BatchOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        // ① 一条 UPDATE 声明整批：抢到的才归我处理，抢不到的（已处理过）自动略过
        const claimed = await tx.$queryRaw<ClaimedEvent[]>`
          UPDATE error_events
             SET processed_at = now()
           WHERE event_id IN (${Prisma.join(eventIds)})
             AND processed_at IS NULL
          RETURNING event_id, mechanism, "type", message, stack, timestamp, release, project_id, user_id, environment
        `;

        if (claimed.length === 0) {
          return {
            claimed: 0,
            skipped: eventIds.length,
            groups: 0,
            symbolicated: 0,
            timesSeenByGroup: [],
          };
        }

        // ② 逐条算指纹（CPU + 可能的 Sourcemap 读），再按指纹聚成桶
        const buckets = new Map<string, FingerprintBucket>();
        let symbolicated = 0;

        for (const ev of claimed) {
          const frames = parseFrames(ev.stack);
          const resolution = await this.sourcemaps.symbolicate(
            tx,
            ev.project_id,
            ev.release,
            frames,
          );
          const isSymbolicated = resolution.allResolved;
          if (isSymbolicated) symbolicated += 1;

          const groupingVersion = isSymbolicated
            ? GROUPING_VERSION_SYMBOLICATED
            : GROUPING_VERSION_RAW;

          const fingerprint = isSymbolicated
            ? computeSymbolicatedFingerprint({
                type: ev.type,
                message: ev.message,
                frames: resolution.frames,
              })
            : computeFingerprint({
                type: ev.type,
                message: ev.message,
                stack: ev.stack,
              });

          const key = `${ev.project_id}::${groupingVersion}::${fingerprint}`;
          let bucket = buckets.get(key);
          if (bucket === undefined) {
            bucket = {
              projectId: ev.project_id,
              groupingVersion,
              fingerprint,
              title: buildTitle(ev.type, ev.message),
              culprit: isSymbolicated
                ? buildSymbolicatedCulprit(resolution.frames)
                : buildCulprit(frames),
              items: [],
            };
            buckets.set(key, bucket);
          }

          bucket.items.push({
            event: ev,
            framesToStore: isSymbolicated ? resolution.frames : frames,
          });
        }

        // ③ 每个指纹桶：一次 upsert 把 times_seen 累加 k 条
        const timesSeenByGroup: string[] = [];

        for (const bucket of buckets.values()) {
          const k = bucket.items.length;
          const first = bucket.items.reduce((a, b) =>
            b.event.timestamp < a.event.timestamp ? b : a,
          );
          const latest = bucket.items.reduce((a, b) =>
            b.event.timestamp > a.event.timestamp ? b : a,
          );

          const group = await tx.errorGroup.upsert({
            where: {
              projectId_groupingVersion_fingerprint: {
                projectId: bucket.projectId,
                groupingVersion: bucket.groupingVersion,
                fingerprint: bucket.fingerprint,
              },
            },
            create: {
              projectId: bucket.projectId,
              groupingVersion: bucket.groupingVersion,
              fingerprint: bucket.fingerprint,
              title: bucket.title,
              culprit: bucket.culprit,
              firstSeen: first.event.timestamp,
              lastSeen: latest.event.timestamp,
              // 首次创建时直接写 k，而不是 1 —— 本批这 k 条就是它的全部历史
              timesSeen: k,
              firstRelease: first.event.release,
              lastRelease: latest.event.release,
              lastEnvironment: latest.event.environment,
            },
            update: {
              lastSeen: latest.event.timestamp,
              // 与逐条路径同一条规则：没配版本/环境的不能把已有值抹成 NULL
              ...(latest.event.release !== null
                ? { lastRelease: latest.event.release }
                : {}),
              ...(latest.event.environment !== null
                ? { lastEnvironment: latest.event.environment }
                : {}),
              // 原子累加 k，而不是增 1
              timesSeen: { increment: k },
            },
          });

          timesSeenByGroup.push(String(group.timesSeen));
          bucket.groupId = group.id;

          // FR-4.8 状态机：已解决又出事 → 回归未处理（稀有路径，保持不变）
          if (group.status === 'resolved') {
            await tx.errorGroup.update({
              where: { id: group.id },
              data: { status: 'unresolved', resolvedAt: null },
            });
            this.logger.log(
              `问题回归: id=${group.id} resolved → unresolved（收到新事件）`,
            );
          }

          // ④ 影响用户：桶内去重后一次插入，只把"真的新增"计入 users_seen
          const userIds = [
            ...new Set(
              bucket.items
                .map((item) => item.event.user_id)
                .filter((id): id is string => id !== null && id !== undefined),
            ),
          ];

          let newUsers = 0;
          if (userIds.length > 0) {
            const inserted = await tx.affectedUser.createMany({
              data: userIds.map((userKey) => ({
                projectId: bucket.projectId,
                groupId: group.id,
                userKey,
                firstRelease: first.event.release,
              })),
              skipDuplicates: true,
            });
            newUsers = inserted.count;

            if (newUsers > 0) {
              await tx.errorGroup.update({
                where: { id: group.id },
                data: { usersSeen: { increment: newUsers } },
              });
            }
          }

          // ⑤ 小时聚合：按事件时间分桶，每桶一次 upsert，event_count 累加该桶条数
          const byHour = new Map<number, { hour: Date; count: number }>();
          for (const item of bucket.items) {
            const hour = toHourBucket(item.event.timestamp);
            const entry = byHour.get(hour.getTime());
            if (entry === undefined) byHour.set(hour.getTime(), { hour, count: 1 });
            else entry.count += 1;
          }

          // user_count 只能归属到某一小时：统一记到本批最新事件所属的小时桶。
          // 逐条路径是"每条各自 +0/1"，批次化之后无法再把新增用户精确拆到各小时；
          // 同一小时内的结果完全一致（bench 与绝大多数真实批次都属于这种情况）。
          const latestHourKey = toHourBucket(latest.event.timestamp).getTime();

          for (const [key, entry] of byHour) {
            const isLatestHour = key === latestHourKey;
            await tx.issueStatHourly.upsert({
              where: {
                projectId_groupId_hour: {
                  projectId: bucket.projectId,
                  groupId: group.id,
                  hour: entry.hour,
                },
              },
              create: {
                projectId: bucket.projectId,
                groupId: group.id,
                hour: entry.hour,
                eventCount: entry.count,
                userCount: isLatestHour ? newUsers : 0,
              },
              update: {
                eventCount: { increment: entry.count },
                ...(isLatestHour && newUsers > 0
                  ? { userCount: { increment: newUsers } }
                  : {}),
              },
            });
          }
        }

        // ⑥ 回填 group_id + 符号化 frames：一条 SQL 更新整批。
        // 逐条 update 会再打 N 次数据库，把批量省下的往返又还回去。
        const values: Prisma.Sql[] = [];
        for (const bucket of buckets.values()) {
          for (const item of bucket.items) {
            const framesJson =
              item.framesToStore.length > 0
                ? JSON.stringify(item.framesToStore)
                : null;
            values.push(
              Prisma.sql`(${item.event.event_id}::text, ${bucket.groupId}::uuid, ${
                framesJson
              }::jsonb)`,
            );
          }
        }

        await tx.$executeRaw`
          UPDATE error_events AS e
             SET group_id = v.group_id,
                 -- 没有 frames 时不覆盖原有值（与逐条路径"字段整个不出现"等价）
                 stacktrace_frames = COALESCE(v.frames, e.stacktrace_frames)
            FROM (VALUES ${Prisma.join(values)}) AS v(event_id, group_id, frames)
           WHERE e.event_id = v.event_id
        `;

        return {
          claimed: claimed.length,
          skipped: eventIds.length - claimed.length,
          groups: buckets.size,
          symbolicated,
          timesSeenByGroup,
        };
      },
      // 50 条一批时，符号化（首次可能读盘解析）+ 5 条 SQL 仍可能在慢盘上超过
      // Prisma 默认的 5 秒事务上限，这里显式放宽
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  /**
   * 原子声明 + 归并。
   *
   * 声明：把 processed_at 从 NULL 抢成 now()，抢到的那一次返回被声明的事件。
   * 用一条 `UPDATE ... WHERE processed_at IS NULL RETURNING ...` 而不是
   * "先 SELECT 再 UPDATE"：读写之间没有缝隙，两个 Worker 抢同一条事件时
   * Postgres 的行锁保证只有一个能改到（另一个 affected=0）。
   *
   * 用 now()（数据库时间）而不是 new Date()：多个 Worker 进程的机器时钟可能不一致，
   * 这个字段要用来判断"谁先处理"，得用同一个时钟源。
   *
   * 归并：算指纹 → upsert error_groups → 回填 group_id。
   * 见类注释：必须在同一个事务里。
   */
  private async claim(eventId: string): Promise<ClaimOutcome | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedEvent[]>`
        UPDATE error_events
           SET processed_at = now()
         WHERE event_id = ${eventId}
           AND processed_at IS NULL
        RETURNING event_id, mechanism, "type", message, stack, timestamp, release, project_id, user_id, environment
      `;

      const claimed = rows[0];
      // 没抢到闸门 → 什么都不做。这里必须早返回：下面是写库操作，
      // 绝不能替别人（或上一次的自己）重复归并
      if (claimed === undefined) return null;

      // ── 归并（W4 / M3）─────────────────────────────────────────────
      const frames = parseFrames(claimed.stack);

      // M3：有 release 才可能找到 Sourcemap；没有 / 找不到 / 只还原了一部分，
      // 都会拿到 allResolved=false，此时整条退回 v1（压缩位置）指纹 ——
      // 与 M2 的行为**完全一致**，不会因为引入了符号化而让历史问题分裂。
      //
      // 注意这一步在事务内、且用了同一个 tx：它要读 release / sourcemap_files，
      // 另开连接会在并发高时把自己卡在连接池上。解析成本靠 service 内的缓存摊薄。
      const resolution = await this.sourcemaps.symbolicate(
        tx,
        claimed.project_id,
        claimed.release,
        frames,
      );
      const symbolicated = resolution.allResolved;

      const groupingVersion = symbolicated
        ? GROUPING_VERSION_SYMBOLICATED
        : GROUPING_VERSION_RAW;

      const fingerprint = symbolicated
        ? computeSymbolicatedFingerprint({
            type: claimed.type,
            message: claimed.message,
            frames: resolution.frames,
          })
        : computeFingerprint({
            type: claimed.type,
            message: claimed.message,
            stack: claimed.stack,
          });

      const culprit = symbolicated
        ? buildSymbolicatedCulprit(resolution.frames)
        : buildCulprit(frames);

      // 落库的 frames：符号化成功存还原结果（看板要展示源码位置 + 上下文），
      // 否则存原始压缩帧 —— 两种形状靠 grouping_version 区分，读侧据此渲染
      const framesToStore = symbolicated ? resolution.frames : frames;

      const group = await tx.errorGroup.upsert({
        where: {
          // 复合唯一约束的输入名 = 字段名用 _ 连接。
          // S0 起是三元组 (project_id, grouping_version, fingerprint) ——
          // 少 projectId 就会被当成"全局唯一"，两个项目的同名错误会合并
          projectId_groupingVersion_fingerprint: {
            projectId: claimed.project_id,
            groupingVersion,
            fingerprint,
          },
        },
        create: {
          projectId: claimed.project_id,
          groupingVersion,
          fingerprint,
          title: buildTitle(claimed.type, claimed.message),
          culprit,
          firstSeen: claimed.timestamp,
          lastSeen: claimed.timestamp,
          timesSeen: 1,
          // 版本与 firstSeen 同一个套路：首次出现时一次写定，之后不动
          firstRelease: claimed.release,
          lastRelease: claimed.release,
          // 环境不是"首次写定"而是"跟随最近一次"（见 update 分支）
          lastEnvironment: claimed.environment,
        },
        update: {
          // firstSeen / firstRelease 有意不更新 —— 见类注释
          lastSeen: claimed.timestamp,
          // release 为空的事件**不能**把已有版本覆盖成 NULL：
          // 未配置版本的页面会和带版本的事件归到同一个问题里，
          // 直接写 lastRelease: null 会把好不容易记下的版本抹掉
          ...(claimed.release !== null ? { lastRelease: claimed.release } : {}),
          // 同理：没配 environment 的上报不能把已知环境抹成 NULL，
          // 否则一条"忘了配"的事件就能让这个问题从环境筛选里消失
          ...(claimed.environment !== null
            ? { lastEnvironment: claimed.environment }
            : {}),
          // 必须用原子 increment，不能写成 timesSeen + 1：
          // 两个并发 Worker 各自读改写会互相覆盖，实际发生 2 次却只加 1
          timesSeen: { increment: 1 },
        },
      });

      // ── FR-4.8 状态机：已解决的问题又出事 → 回归为未处理 ────────────
      // upsert 返回的是写入后的行，所以这里读到的 status 就是最新状态。
      // 只在 resolved 时多做一次写：这是稀有路径，不值得为它把 upsert
      // 改写成带 CASE 的手写 SQL。
      // 注：日志在事务内打。万一后面回滚，这行会成为"说过但没发生"；
      // 考虑到它会随重试再打一遍，且状态可在 GET /issues 里直接核对，接受。
      if (group.status === 'resolved') {
        await tx.errorGroup.update({
          where: { id: group.id },
          data: { status: 'unresolved', resolvedAt: null },
        });
        this.logger.log(
          `问题回归: id=${group.id} resolved → unresolved（收到新事件）`,
        );
      }

      // ── 影响用户去重（M5 / FR-4.4）─────────────────────────────────
      // 语义：users_seen = "这个问题见过多少个人"，不是"发生多少次"。
      // 同一个用户报 10 次 → times_seen = 10，users_seen 仍然只加 1。
      //
      // 为什么用 createMany + skipDuplicates 而不是"先查后插"：
      // 两个 Worker 并发处理同一用户的事件时，先查后插会双双通过、两个都去 +1；
      // ON CONFLICT DO NOTHING 把判重交给数据库，返回的 count 才是"真的新增了几行"。
      // 同时判 null 和 undefined：类型上只有 string | null，但运行时"这一列没拿到"
      // （RETURNING 漏写、或测试替身没造这个字段）会是 undefined ——
      // 只判 null 的话会走进分支，然后对着不存在的 affectedUser 取属性抛 TypeError，
      // 那是一个和业务毫无关系的报错。
      // 这一小时"新增"了几个受影响用户 —— 给下面的小时聚合用
      let newUsers = 0;
      if (claimed.user_id !== null && claimed.user_id !== undefined) {
        const inserted = await tx.affectedUser.createMany({
          data: [
            {
              projectId: claimed.project_id,
              groupId: group.id,
              userKey: claimed.user_id,
              // 记下"这个用户从哪个版本开始受影响"。非主键字段，不参与去重
              firstRelease: claimed.release,
            },
          ],
          skipDuplicates: true,
        });

        newUsers = inserted.count;
        if (newUsers > 0) {
          // 只有"新面孔"才 +1。increment 是原子的，不能写成 usersSeen + 1
          await tx.errorGroup.update({
            where: { id: group.id },
            data: { usersSeen: { increment: newUsers } },
          });
        }
      }

      // ── 小时聚合（M5 / B2）─────────────────────────────────────────
      // **必须和 times_seen 在同一个事务里**：这两处是"同一次发生"的两笔账。
      // 分开写的话，归并后面报错回滚时 times_seen 撤销了、聚合却已经落库，
      // 对账会立刻发现 sum(event_count) ≠ 明细条数 —— 而且聚合表只增不减，
      // 这种漂移一旦产生就只能靠回填重建。
      //
      // 桶用**事件发生时间**（claimed.timestamp）截到 UTC 整点，不是 processed_at：
      //   ① 看板按事件时间排序，趋势图必须与列表同源
      //   ② 回填脚本只能从明细重建，明细里有 timestamp，没有"当时"的 processed_at
      //   ③ 乱序补报的旧事件应当回到它自己那一小时，而不是补报的那一刻
      const hour = toHourBucket(claimed.timestamp);

      await tx.issueStatHourly.upsert({
        where: {
          // 复合主键的输入名 = 字段名用 _ 连接
          projectId_groupId_hour: {
            projectId: claimed.project_id,
            groupId: group.id,
            hour,
          },
        },
        create: {
          projectId: claimed.project_id,
          groupId: group.id,
          hour,
          eventCount: 1,
          // 首次出现的那条事件本身可能就带来一个新用户
          userCount: newUsers,
        },
        update: {
          // increment 而不是读改写：两个并发 Worker 落到同一小时会互相覆盖
          eventCount: { increment: 1 },
          // 没有新面孔时字段整个不出现，省掉一次无意义的写
          ...(newUsers > 0 ? { userCount: { increment: newUsers } } : {}),
        },
      });

      await tx.errorEvent.update({
        where: { eventId },
        data: {
          groupId: group.id,
          // Json? 列不能直接写 null（同 breadcrumbs 的既有写法，见
          // error-events.service.ts 的 toRow）：没有 frames 时字段整个不出现，
          // 列保持 SQL NULL，语义最干净
          ...(framesToStore.length > 0
            ? {
                stacktraceFrames:
                  framesToStore as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
      // ───────────────────────────────────────────────────────────────

      return {
        event: claimed,
        fingerprint,
        groupId: group.id,
        timesSeen: group.timesSeen,
        symbolicated,
      };
    });
  }

  /** 没抢到声明时，查清楚是哪一种情况再记日志（重复投递是正常现象，不该刷 error） */
  private async explainUnclaimed(
    eventId: string,
    requestId?: string,
  ): Promise<void> {
    const row = await this.prisma.errorEvent.findUnique({
      where: { eventId },
      select: { processedAt: true },
    });

    if (row === null) {
      this.logger.warn(
        `事件不存在，跳过: event_id=${eventId} requestId=${requestId ?? '-'}`,
      );
      return;
    }

    this.logger.debug(
      `已处理过，跳过: event_id=${eventId} requestId=${requestId ?? '-'} ` +
        `processed_at=${row.processedAt?.toISOString() ?? '?'}`,
    );
  }

  /**
   * 每一次尝试失败都会触发（含还有重试次数的那几次）。
   *
   * S7 起由 `ProjectWorkerManager` 给每个 Worker 挂 `worker.on('failed', ...)`
   * 转发进来 —— 这里去掉装饰器，逻辑一行没改。
   */
  async onFailed(
    job: Job<ErrorEventJobData> | undefined,
    err: Error,
  ): Promise<void> {
    // job 为 undefined 是 BullMQ 的类型约定：反序列化都失败时拿不到 job 对象
    if (job === undefined) {
      this.logger.error(`任务失败且拿不到 job 详情: ${err.message}`);
      return;
    }

    const attempts = job.opts.attempts ?? 1;
    // M7-T5 起一个 job 可能带多条主键。DLQ 里必须把**整批**都留下来，
    // 否则失败现场只剩下一个代表 id，其余事件永远查不到是被哪次失败带走的。
    const eventIds = jobEventIds(job.data);
    /** 只用于日志/前缀的那一个代表 id */
    const eventId = eventIds[0] ?? '(unknown)';
    // requestId 跟着 job 一起进来，这里必须**接着往下传**（进 DLQ 载荷 + 日志）：
    // 一条事件最终进了死信，几乎是最需要回溯"它当初是从哪次请求来的"的场景
    const requestId = job.data.requestId;

    // 还有重试次数：只 warn。这是正常路径，不是故障
    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `第 ${job.attemptsMade}/${attempts} 次失败，将重试: event_id=${eventId} ` +
          `requestId=${requestId ?? '-'} 原因=${err.message}`,
      );
      return;
    }

    // 重试耗尽 → 转 DLQ
    const payload: ErrorEventDlqData = {
      eventIds,
      eventId,
      requestId,
      failedReason: err.message,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };

    try {
      // DLQ 的 jobId 必须每次都不同：同一个事件以后再失败时，如果沿用同一个 jobId，
      // BullMQ 会静默去重（不报错也不写入），那次失败的现场就没了。
      // 前缀保留 eventId 是为了好 grep；唯一性靠 randomUUID —— 用时间戳不够，
      // 同一毫秒内的两次失败（测试就撞上了）会算出同一个 id。
      await this.dlq.add(ERROR_EVENT_JOB, payload, {
        ...DLQ_JOB_OPTIONS,
        jobId: `${toJobId(eventId)}-${randomUUID()}`,
      });
      // 只有真的写进 DLQ 才记这一笔。写失败时事件仍然丢了，
      // 但它并没有"进入死信队列"——把失败记成成功会让这个指标骗人
      this.metrics.recordDlq(projectIdOf(job.queueName));
      this.logger.error(
        `重试 ${job.attemptsMade} 次仍失败，已转入 DLQ: event_id=${eventId} ` +
          `requestId=${requestId ?? '-'} 原因=${err.message}`,
      );
    } catch (dlqErr) {
      // DLQ 也写不进去（通常是 Redis 也挂了）：这时失败现场就只剩这一行日志，
      // 必须用 error 级别打出来，别让它悄悄消失
      this.logger.error(
        `转入 DLQ 失败，失败现场仅存于本行日志: event_id=${eventId} ` +
          `requestId=${requestId ?? '-'} ` +
          `原始原因=${err.message} DLQ 错误=${String(dlqErr)}`,
      );
    }
  }
}

/** 按**码点**截断，避免把 emoji 的代理对切成半个（同 fingerprint.ts 的 truncate） */
function truncate(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join('')}…`;
}

/**
 * 从队列名反解项目 id（`error-events-<uuid>` → `<uuid>`）。
 *
 * DLQ 的 job 载荷里只有 eventId（见 queue.constants 的"只带主键"约定），
 * 但指标想按项目分。队列名是唯一现成、且一定正确的来源 ——
 * 拿不到就记 `unknown`，绝不让一个畸形名字把整条失败处理链路搞崩。
 */
function projectIdOf(queueName: string | undefined): string {
  const prefix = `${ERROR_EVENT_QUEUE}-`;
  if (typeof queueName !== 'string') return 'unknown';
  return queueName.startsWith(prefix) ? queueName.slice(prefix.length) : 'unknown';
}
