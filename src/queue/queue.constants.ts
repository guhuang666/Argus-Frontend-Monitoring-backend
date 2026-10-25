import type { JobsOptions } from 'bullmq';

/**
 * 队列契约（W3）—— 生产者（ingest）与消费者（worker）共用这一份常量。
 *
 * 单独成文件是为了避免"生产者 import 消费者的模块"这种反向依赖：
 * 两边都只依赖契约，谁也不知道谁的存在。
 */

/**
 * 归并队列的**名字前缀**（M4-S7 起）。
 *
 * 以前所有项目共用一条 `error-events`；现在每个项目一条
 * `error-events-<projectId>`，用 `projectQueueName()` 拼。
 * 这条基础队列本身已经不再承载 job，保留它有两个用途：
 *   · 作为"连接配置的锚点"（`queue.opts.connection` 拷给动态创建的队列）
 *   · 启动时探测 Redis 是否就绪
 */
export const ERROR_EVENT_QUEUE = 'error-events';

/**
 * 按项目隔离的队列名（M4-S7 / FR-6.6）。
 *
 * ── 为什么按项目分队列 ──────────────────────────────────────────────────
 * 单队列时，A 项目灌 10 万条进来，B 项目的 3 条就排在队尾 —— B 付了钱，
 * 却因为 A 被攻击而看不到自己的报错。分队列之后，A 的积压只影响 A。
 *
 * ── 为什么队列名带上项目 id 就够了 ──────────────────────────────────────
 * BullMQ 的队列是"按名字隔离"的：不同名字的队列有各自独立的 key、
 * 各自的 Worker、各自的并发度。所以"隔离"不需要额外机制，只需要换个名字。
 *
 * ── ⚠️ 分隔符必须是 `-`，不能用 `:` ─────────────────────────────────────
 * BullMQ 用 `:` 拼 Redis key（`bull:队列名:wait`），所以它**禁止**队列名
 * 里出现冒号 —— 传进去会直接抛 `Error: Queue name cannot contain :`，
 * 而且是在 `new Queue()` 那一刻抛，整个 sync 循环失败。
 * （实测踩过：第一版写成 `error-events-<id>`，worker 启动即报错。）
 */
export function projectQueueName(projectId: string): string {
  return `${ERROR_EVENT_QUEUE}-${projectId}`;
}

/**
 * 死信队列（DLQ）：重试耗尽后转入。
 *
 * **注意它现在没有消费者** —— 只是把失败现场留一份，等重驱动任务（W8 或后续里程碑）
 * 来捞。另注：docker-compose 里的 redis 没有挂卷，重启即丢，所以这份 DLQ 是"开发期
 * 够用"而不是"审计级可靠"。要做到重启不丢，得换成 PG 表（见 W3 交接说明）。
 */
export const ERROR_EVENT_DLQ = 'error-events-dlq';

/** job 名。队列名回答"哪个队列"，job 名回答"干什么"：一个队列以后可能装多种 job */
export const ERROR_EVENT_JOB = 'error-event';

/**
 * 工作 job 的载荷：**只带主键**。
 *
 * 明细（type / message / stack）从 PG 现读，不在 Redis 里存第二份 —— 否则事件在
 * 入库后被修正、或者 schema 演进时，队列里那份就成了过期真相。载荷小还有个副作用
 * 是好事：job 越小，Redis 内存和网络开销越低。
 */
export interface ErrorEventJobData {
  eventId: string;
  /**
   * 产生这条 job 的 HTTP 请求 id（M6-6）。
   *
   * 一次上报的生命周期横跨两个进程：API 收下并入队，worker 取出归并。
   * 没有这个字段时，"这条事件为什么没归并"只能靠时间戳在两个终端里对猜。
   *
   * 可空：脚本 / 补扫任务直接入队时没有 HTTP 上下文。
   */
  requestId?: string;
}

/** 死信载荷：原载荷 + 失败现场，够事后定位就行 */
export interface ErrorEventDlqData extends ErrorEventJobData {
  /** 最后一次失败的原因（Error.message） */
  failedReason: string;
  /** 一共尝试了几次（等于 attempts，因为只有重试耗尽才会进 DLQ） */
  attemptsMade: number;
  /** 转入 DLQ 的时间（ISO 字符串；Redis 里不存 Date） */
  failedAt: string;
}

/**
 * 工作 job 的默认选项。
 *
 * attempts: 3 —— 是**总次数**不是重试次数：首次 + 2 次重试。
 *   backoff exponential delay 1000 → 第 2 次隔 1s，第 3 次隔 2s。
 *
 * removeOnComplete 留 1 小时 / 最多 5000 条：保留窗口 = jobId 去重的有效窗口。
 *   队列里的 job 一旦被删，同 jobId 就能再次入队 —— 留一小时是为了让"SDK 重复上报
 *   同一事件"落在窗口内被静默忽略，同时不让 Redis 无限长。
 *
 * removeOnFail: true —— 失败 job 立刻删掉，原因有两条：
 *   ① 失败现场已经由 DLQ 存了一份，这份留着是重复的；
 *   ② 更要紧的是**别把补扫堵死**：失败 job 如果留在 failed 集合里，W8 的补扫按
 *      event_id 重新入队时会被 jobId 去重静默吃掉，那条事件就永远处理不了了。
 *      删掉它，补扫才有机会重来。
 *
 * 注：真正的幂等闸门不是 jobId 而是 error_events.processed_at（见 processor），
 * jobId 只是省掉重复劳动的第一道闸。
 */
export const ERROR_EVENT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: true,
};

/**
 * DLQ job 选项：不重试、不自动清理。
 *
 * 不清理是刻意的 —— DLQ 的价值就在于"东西还在那儿"，清理策略要等重驱动任务
 * 落地时一起定（保住多久、重驱动几次后归档）。
 */
export const DLQ_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: false,
  removeOnFail: false,
};

/**
 * event_id → BullMQ 的 jobId。
 *
 * 直接用 event_id 是最理想的（排查时 jobId 就是事件主键），但 BullMQ 6 对自定义
 * jobId 有两条硬校验（`bullmq/dist/cjs/classes/job.js:904-914`），踩中会**抛异常**、
 * 直接把入队打回来：
 *   · 纯整数形式的字符串 → `Custom Id cannot be integers`（如 event_id = "12345"）
 *   · 含 `:` 且不是正好 3 段   → `Custom Id cannot contain :`
 *
 * SDK 生成的 id 是 UUID 或十六进制串，两条都不沾；但 `POST /api/v1/error` 是对公网
 * 开放的，DTO 只校验"1~128 个字符"，第三方客户端发什么形状都收得下。所以这里做一次
 * 映射，把非法形状挡在入队之前：
 *   · `%` 先编码成 `%25`，再把 `:` 编码成 `%3A` —— 映射是单射（`a:b` 与 `a_b` 不会
 *     互相顶掉），且不再含冒号
 *   · 纯数字前面加 `e-`（带字母后 parseInt 得 NaN，整数校验必过）
 *
 * 常规 id（UUID）原样返回，jobId 依然等于 event_id。
 */
export function toJobId(eventId: string): string {
  const encoded = eventId.replace(/%/g, '%25').replace(/:/g, '%3A');
  return /^\d+$/.test(encoded) ? `e-${encoded}` : encoded;
}
