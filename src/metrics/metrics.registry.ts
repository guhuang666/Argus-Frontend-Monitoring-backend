import { Counter, Gauge, Registry } from 'prom-client';

/**
 * 指标注册表（M6-7 最小版）。
 *
 * ── 为什么要单独一个 Registry，而不是用 prom-client 的默认全局注册表 ──────
 * 默认注册表是模块级单例，任何 import 了 prom-client 的文件都能往里塞指标。
 * 一旦某个测试或临时脚本注册了同名指标，进程启动就直接抛
 * "A metric with the name X has already been registered"——而且是启动期崩溃，
 * 排查成本高。显式一个 registry，谁注册了什么在这里一目了然。
 *
 * ── 为什么指标名都带 argus_ 前缀 ─────────────────────────────────────────
 * Prometheus 里的名字是全局的：`http_requests_total` 这种通用名会跟
 * node_exporter、其他中间件撞车。加前缀等于给指标划命名空间。
 */
export const registry = new Registry();

/**
 * 成功入库的上报事件数。
 *
 * 只在 `create` 成功之后 +1：重复上报（同一 event_id 撞主键）不算新的上报量，
 * 否则"上报量"会变成"上报请求数"，压测时同一批事件重发会被重复计数。
 *
 * 标签只用 project_id：项目数是有限集合（一个组织十几个），序列数量可控。
 * 千万不要加 event_id / url / message —— 那会让时间序列数量爆炸。
 */
export const ingestEventsTotal = new Counter({
  name: 'argus_ingest_events_total',
  help: '成功入库的上报事件数',
  labelNames: ['project_id'],
  registers: [registry],
});

/**
 * 被拒绝的上报数。
 *
 * reason 目前只有 rate_limit。将来加"公钥无效""负载过大"时直接多一个取值，
 * 不需要新建指标——这正是用标签而不是用多个指标名的理由。
 */
export const ingestRejectedTotal = new Counter({
  name: 'argus_ingest_rejected_total',
  help: '被拒绝的上报数（按原因分）',
  labelNames: ['project_id', 'reason'],
  registers: [registry],
});

/* ─────────────────────── worker 侧指标（M6-7 v1）─────────────────────── */

/**
 * 归并 job 的**尝试**次数（不是 job 数）。
 *
 * `succeeded` = Worker 的 completed 事件（一个 job 最多贡献 1 次）；
 * `failed` = **每一次失败的尝试**（一个重试 3 次的 job 会贡献 3 次）。
 *
 * ── 为什么名字是 attempts 而不是 processed ──────────────────────────────
 * 叫 `jobs_processed` 时，一个重试 3 次的 job 看起来像"3 个 job 失败了"。
 * 名字里带 attempts，读的人一眼就知道分母是"尝试次数"：
 *   重试率 = failed / (succeeded + failed)
 *   处理速率 = succeeded 的 rate()
 * 想知道"真正丢了多少"，看 `argus_dlq_jobs_total`（那才是 job 口径）。
 *
 * 刻意不带 project_id：这是进程级吞吐，按项目拆会让序列数乘上项目数；
 * 想知道"哪个项目慢"，看队列积压那条 Gauge 就够了。
 */
export const jobAttemptsTotal = new Counter({
  name: 'argus_job_attempts_total',
  help: '归并 job 的处理尝试次数（按结果分）',
  labelNames: ['result'],
  registers: [registry],
});

/**
 * 进入死信队列的 job 数。
 *
 * 这个数字**应当长期为 0**。只要它涨，就说明有事件重试 3 次仍失败、
 * 已经被转进 DLQ 等人捞 —— 是"数据正在丢"的直接证据，值得单独告警。
 */
export const dlqJobsTotal = new Counter({
  name: 'argus_dlq_jobs_total',
  help: '转入死信队列的 job 数',
  labelNames: ['project_id'],
  registers: [registry],
});

/**
 * 读队列长度的函数。由 MetricsService 在构造时注入。
 *
 * ── 为什么不直接把 Gauge 建在 MetricsService 里 ────────────────────────
 * Gauge 的构造会把名字注册进 registry，**同名注册第二次直接抛异常**。
 * 生产环境只有一个实例没问题，但测试里每个用例都会 new 一次，
 * 第一次之后全崩（"A metric with the name argus_queue_jobs has already
 * been registered"）。放模块级、只建一次，多实例只是换掉采集函数，
 * 不会重复注册。
 */
let collectQueueJobs: (() => Promise<void>) | null = null;

/** 换掉队列采集函数（MetricsService 构造时调用） */
export function setQueueCollector(fn: () => Promise<void>): void {
  collectQueueJobs = fn;
}

/**
 * 队列积压：抓取时现场读，不是定时刷新。
 *
 * 采集函数还没注入时（比如某些脚本只 import 了 registry）不做任何事 ——
 * 宁可在指标里少一条，也不要在启动顺序上制造隐含依赖。
 */
export const queueJobs = new Gauge({
  name: 'argus_queue_jobs',
  help: '各项目队列中各状态的任务数',
  labelNames: ['project_id', 'state'],
  registers: [registry],
  collect: async () => {
    if (collectQueueJobs !== null) {
      await collectQueueJobs();
    }
  },
});
