import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DLQ_JOB_OPTIONS,
  ERROR_EVENT_DLQ,
  ERROR_EVENT_JOB,
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
  ) {}

  /**
   * 处理一条事件。
   *
   * 抛异常 = 这次尝试失败，BullMQ 按 ERROR_EVENT_JOB_OPTIONS 的退避策略重试，
   * 3 次用尽后由 onFailed 转 DLQ。所以这里"该抛就抛"：DB 短暂不可用就应该重试，
   * 不要自己吞掉错误假装成功 —— 吞掉等于永久丢失这条事件的归并。
   */
  async handle(job: Job<ErrorEventJobData>): Promise<void> {
    const { eventId } = job.data;
    const outcome = await this.claim(eventId);

    if (outcome === null) {
      // 声明失败有两种可能，分开记：区分"重复投递"和"job 指向了不存在的事件"
      await this.explainUnclaimed(eventId);
      return;
    }

    const { event, fingerprint, groupId, timesSeen, symbolicated } = outcome;
    // 日志带上 group / fingerprint / times：验收时不用查库就能看出
    // 两条上报有没有落进同一个问题里。
    // sym=v2/raw=v1 同理：符号化有没有生效，一条日志就能判断
    this.logger.log(
      `已消费 event_id=${eventId} group=${groupId.slice(0, 8)} ` +
        `fp=${fingerprint.slice(0, 8)} times=${timesSeen} ` +
        `ver=${symbolicated ? 'v2' : 'v1'} ` +
        `mechanism=${event.mechanism} type=${event.type} ` +
        `message="${truncate(event.message, LOG_MESSAGE_LIMIT)}"`,
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
  private async explainUnclaimed(eventId: string): Promise<void> {
    const row = await this.prisma.errorEvent.findUnique({
      where: { eventId },
      select: { processedAt: true },
    });

    if (row === null) {
      this.logger.warn(`事件不存在，跳过: event_id=${eventId}`);
      return;
    }

    this.logger.debug(
      `已处理过，跳过: event_id=${eventId} processed_at=${row.processedAt?.toISOString() ?? '?'}`,
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
    const eventId = job.data.eventId;

    // 还有重试次数：只 warn。这是正常路径，不是故障
    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `第 ${job.attemptsMade}/${attempts} 次失败，将重试: event_id=${eventId} 原因=${err.message}`,
      );
      return;
    }

    // 重试耗尽 → 转 DLQ
    const payload: ErrorEventDlqData = {
      eventId,
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
      this.logger.error(
        `重试 ${job.attemptsMade} 次仍失败，已转入 DLQ: event_id=${eventId} 原因=${err.message}`,
      );
    } catch (dlqErr) {
      // DLQ 也写不进去（通常是 Redis 也挂了）：这时失败现场就只剩这一行日志，
      // 必须用 error 级别打出来，别让它悄悄消失
      this.logger.error(
        `转入 DLQ 失败，失败现场仅存于本行日志: event_id=${eventId} ` +
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
