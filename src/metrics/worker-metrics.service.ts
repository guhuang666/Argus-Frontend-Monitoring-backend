import { Injectable } from '@nestjs/common';
import { dlqJobsTotal, jobAttemptsTotal } from './metrics.registry';

/**
 * worker 侧的埋点入口（M6-7）。
 *
 * ── 计数与暴露是两条链路 ────────────────────────────────────────────────
 * DI 决定"谁能改数字"，HTTP 决定"谁能读数字"。本服务只管前者：把数字写进
 * **worker 进程内存里的 registry**。
 *
 * 读出来由 `WorkerMetricsServerService` 负责：它在 9464 端口开一个只服务
 * `/metrics` 的端点，序列化的就是同一个 registry。所以以后再加指标，
 * 这里一行都不用改，新序列会自动出现在那个端点上。
 *
 * ── 为什么包一层 service，而不是直接在 processor 里 import 计数器 ──────
 * ① 测试里可以传假实现，不必让每个用例都去动全局 registry
 * ② 以后要加"按项目记录""采样"这类逻辑，只有一个地方要改
 * ③ 调用点读起来是 `metrics.recordAttempt('succeeded')`，
 *    比 `jobAttemptsTotal.inc({ result: 'succeeded' })` 更接近业务语言
 */
@Injectable()
export class WorkerMetricsService {
  /**
   * 一次 job 尝试结束。
   *
   * `succeeded` 只在真正完成时记一次；`failed` **每次失败尝试都记**，
   * 所以一个重试 3 次的 job 会贡献 3 个 failed + 0 或 1 个 succeeded。
   * 指标名叫 `argus_job_attempts_total`，读的人不会把它误解成"job 数"。
   */
  recordAttempt(result: 'succeeded' | 'failed'): void {
    jobAttemptsTotal.inc({ result });
  }

  /**
   * 一条事件进入死信队列。
   *
   * 只在 `dlq.add()` **成功之后**调用：DLQ 写入失败时这条事件仍然丢了，
   * 但它并没有"进入死信队列"——把失败当成成功记账，会让这个指标失真。
   */
  recordDlq(projectId: string): void {
    dlqJobsTotal.inc({ project_id: projectId });
  }
}
