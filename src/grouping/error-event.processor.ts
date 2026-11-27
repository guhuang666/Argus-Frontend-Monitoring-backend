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
  toJobId,
  type ErrorEventDlqData,
  type ErrorEventJobData,
  type ErrorEventRef,
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
    const events = job.data.events ?? [];
    const requestId = job.data.requestId;

    if (events.length === 0) {
      this.logger.warn(`job 载荷里没有事件坐标，跳过: jobId=${job.id ?? '-'}`);
      return;
    }

    // ── 批量路径（M7-T5）──────────────────────────────────────────────
    const summary = await this.claimMany(events);

    if (summary.claimed === 0) {
      // 整批都没抢到：多半是重复投递（退场时 visibilitychange + pagehide 会发两次）
      await this.explainUnclaimed(events[0], requestId);
      return;
    }

    // 一条汇总日志而不是 N 条：批量之后逐条打会把日志量放大 50 倍，
    // 而排查时真正需要的是「这一批进了几个问题、跳过几条」。
    this.logger.log(
      `已消费 ${summary.claimed}/${events.length} 条 requestId=${requestId ?? '-'} ` +
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
  private async claimMany(events: ErrorEventRef[]): Promise<BatchOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        // ① 一条 UPDATE 声明整批：抢到的才归我处理，抢不到的（已处理过）自动略过
        //
        // 条件用 `(event_id, "timestamp")` 行值比较，而不是只有 event_id：
        // error_events 按 timestamp 分区后每天一个分区，而 PostgreSQL 分区表
        // **没有全局索引** —— 只带 event_id 时 planner 做不了分区裁剪，得把保留期内
        // 所有分区翻一遍（每个分区一次索引查找，UPDATE 还要逐个分区加行锁）。
        // 带上分区键后直接命中单个分区的复合主键索引，代价从 O(分区数) 降到 O(1)。
        const refs = events.map(
          (e) => Prisma.sql`(${e.eventId}::text, ${e.timestamp}::timestamptz)`,
        );
        const claimed = await tx.$queryRaw<ClaimedEvent[]>`
          UPDATE error_events
             SET processed_at = now()
           WHERE (event_id, "timestamp") IN (${Prisma.join(refs)})
             AND processed_at IS NULL
          RETURNING event_id, mechanism, "type", message, stack, timestamp, release, project_id, user_id, environment
        `;

        if (claimed.length === 0) {
          return {
            claimed: 0,
            skipped: events.length,
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
          const userIds = new Set<string>();
          for (const item of bucket.items) {
            const userKey = item.event.user_id;
            if (userKey !== null && userKey !== undefined) userIds.add(userKey);
          }

          let newUsers = 0;
          if (userIds.size > 0) {
            const inserted = await tx.affectedUser.createMany({
              data: [...userIds].map((userKey) => ({
                projectId: bucket.projectId,
                groupId: group.id,
                userKey,
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

          // 小时聚合只记事件数。新增用户数不在这里落地 —— 它由
          // affected_users.first_seen 直接按窗口查出来（stats.service 的 byUsers），
          // 这样不用把"整批 newUsers"硬塞进某一小时，口径也不会被客户端时钟带偏。
          for (const entry of byHour.values()) {
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
              },
              update: {
                eventCount: { increment: entry.count },
              },
            });
          }
        }

        // ⑥ 回填 group_id + 符号化 frames：一条 SQL 更新整批。
        // 逐条 update 会再打 N 次数据库，把批量省下的往返又还回去。
        //
        // 分两步写，只为看得懂：
        //   ① 先摊平成普通数组 —— "每条事件要写什么"一目了然
        //   ② 再统一转成 SQL 的 VALUES 行
        const rows: Array<{
          eventId: string;
          timestamp: Date;
          groupId: string | undefined;
          frames: string | null;
        }> = [];

        for (const bucket of buckets.values()) {
          for (const item of bucket.items) {
            rows.push({
              eventId: item.event.event_id,
              timestamp: item.event.timestamp,
              groupId: bucket.groupId,
              frames:
                item.framesToStore.length > 0
                  ? JSON.stringify(item.framesToStore)
                  : null,
            });
          }
        }

        // 一行 = 一个四元组 (event_id, ts, group_id, frames)。
        // ::text / ::timestamptz / ::uuid / ::jsonb 是给参数标类型 —— 参数化之后
        // Postgres 推断不出类型，不标会报 "could not determine data type"。
        // Prisma.sql 保证值走占位符（$1、$2…），不是拼字符串。
        //
        // 定位同样带上 ts（分区键）：只按 event_id 更新会扫遍保留期内所有分区。
        const values = rows.map(
          (row) =>
            Prisma.sql`(${row.eventId}::text, ${row.timestamp}::timestamptz, ${row.groupId}::uuid, ${row.frames}::jsonb)`,
        );

        await tx.$executeRaw`
          UPDATE error_events AS e
             SET group_id = v.group_id,
                 -- 没有 frames 时不覆盖原有值（与逐条路径"字段整个不出现"等价）
                 stacktrace_frames = COALESCE(v.frames, e.stacktrace_frames)
            FROM (VALUES ${Prisma.join(values)}) AS v(event_id, ts, group_id, frames)
           WHERE e.event_id = v.event_id
             AND e."timestamp" = v.ts
        `;

        return {
          claimed: claimed.length,
          skipped: events.length - claimed.length,
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
   * 没抢到声明时，查清楚是哪一种情况再记日志（重复投递是正常现象，不该刷 error）。
   *
   * ⚠️ 这里仍然只按 `eventId` 单列查。等 `error_events` 真的改成复合主键
   * `(event_id, timestamp)` 后，Prisma 的 `where` 必须换成
   * `{ eventId_timestamp: { eventId, timestamp } }`，否则**编译期**就过不去。
   * 现在 schema 还是单列 `@id`，所以先保持单列；这段只在"整批都没抢到"的
   * 诊断路径上跑，不在热路径。
   */
  private async explainUnclaimed(
    ref: ErrorEventRef,
    requestId?: string,
  ): Promise<void> {
    const eventId = ref.eventId;
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
    // M7-T5 起一个 job 可能带多条事件。DLQ 里必须把**整批坐标**都留下来，
    // 否则失败现场只剩下一个代表 id，重驱动任务就找不回其余事件的
    // (event_id, timestamp) —— 少了分区键，连定位都做不到。
    const events = job.data.events ?? [];
    /** 只用于日志/前缀的那一个代表 id */
    const eventId = events[0]?.eventId ?? '(unknown)';
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
      events,
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
