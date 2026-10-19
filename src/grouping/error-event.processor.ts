import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DLQ_JOB_OPTIONS,
  ERROR_EVENT_DLQ,
  ERROR_EVENT_JOB,
  ERROR_EVENT_QUEUE,
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
import { SourcemapLookupService } from './sourcemap-lookup.service';
import {
  buildSymbolicatedCulprit,
  computeSymbolicatedFingerprint,
} from './symbolicate';

/** 单进程并发度。归并是 DB 密集，先给 5；等有真实压测数据再按 PG 连接池上限调 */
const CONCURRENCY = 5;

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
 * 归并 Worker 的消费者（W3 骨架 + W4 归并）。
 *
 * ── 它现在做什么 ────────────────────────────────────────────────────────
 * 消费 `error-event` job，在**一个事务里**做两件事：
 *   ① 把 error_events.processed_at 从 NULL 原子置位 —— 抢到的那次才继续
 *   ② 算指纹 → upsert error_groups → 回填 error_events.group_id
 * 置位成功 = 这条事件归我处理；置位失败 = 别人（或上一次的自己）已经处理过。
 *
 * ── 为什么归并必须和声明在同一个事务里 ──────────────────────────────────
 * **不要**把归并挪到事务外面：一旦归并抛错要重试，重试会在声明那一步看到
 * processed_at 已置位而被自己的闸门挡在门外 —— 事件永久丢失，而且不报错，
 * 只在 debug 日志里留一句"已处理过"。放进事务里，回滚会把闸门一起撤销，
 * 重试才有机会重做。
 *
 * ── MVP 有意留空的东西 ──────────────────────────────────────────────────
 *   · users_seen 恒为 0 —— 上报链路里没有 user_id（DTO 与 toRow 都不带）
 *   · first_release / last_release 由上报的 release 填充（SDK 自 M3 起会带上）；
 *     release 为空的事件**不会**把已有的版本列覆盖成 NULL（见 upsert 的 update）
 *   · first_seen 只在 create 时写 —— 乱序到达的旧事件不会把首见时间往前挪。
 *     这是主动接受的近似：要精确得用 LEAST()，而 Prisma 的 upsert 表达不了
 *   · 单项目 —— error_groups 已去掉 project_id（见 schema.prisma 顶部注释）
 *
 * ── 为什么消费逻辑不在 API 进程里 ───────────────────────────────────────
 * 见 grouping.module.ts 的警告：Worker provider 一旦被 app.module.ts 引入，
 * API 进程也会开始抢 job、跑归并，进程分工和扩容就全乱了。
 */
@Processor(ERROR_EVENT_QUEUE, { concurrency: CONCURRENCY })
export class ErrorEventProcessor extends WorkerHost {
  private readonly logger = new Logger(ErrorEventProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ERROR_EVENT_DLQ)
    private readonly dlq: Queue<ErrorEventDlqData>,
    private readonly sourcemaps: SourcemapLookupService,
  ) {
    super();
  }

  /**
   * 处理一条事件。
   *
   * 抛异常 = 这次尝试失败，BullMQ 按 ERROR_EVENT_JOB_OPTIONS 的退避策略重试，
   * 3 次用尽后由 onFailed 转 DLQ。所以这里"该抛就抛"：DB 短暂不可用就应该重试，
   * 不要自己吞掉错误假装成功 —— 吞掉等于永久丢失这条事件的归并。
   */
  async process(job: Job<ErrorEventJobData>): Promise<void> {
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
        RETURNING event_id, mechanism, "type", message, stack, timestamp, release, project_id
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
        },
        update: {
          // firstSeen / firstRelease 有意不更新 —— 见类注释
          lastSeen: claimed.timestamp,
          // release 为空的事件**不能**把已有版本覆盖成 NULL：
          // 未配置版本的页面会和带版本的事件归到同一个问题里，
          // 直接写 lastRelease: null 会把好不容易记下的版本抹掉
          ...(claimed.release !== null ? { lastRelease: claimed.release } : {}),
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

  /** 每一次尝试失败都会触发（含还有重试次数的那几次） */
  @OnWorkerEvent('failed')
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

  /**
   * Worker 自身的错误（连接断了、反序列化失败……）。
   *
   * 不挂这个监听也不会崩（bullmq 的 emit 兜了 try/catch，最坏是 console.error），
   * 但那样错误就绕过 Nest 的日志体系了，排查时看不见。
   */
  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.logger.warn(`Worker 异常: ${err.message}`);
  }
}

/** 按**码点**截断，避免把 emoji 的代理对切成半个（同 fingerprint.ts 的 truncate） */
function truncate(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join('')}…`;
}
