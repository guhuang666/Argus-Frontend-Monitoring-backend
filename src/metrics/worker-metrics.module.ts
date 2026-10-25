import { Global, Module } from '@nestjs/common';
import { WorkerMetricsServerService } from './worker-metrics-server.service';
import { WorkerMetricsService } from './worker-metrics.service';

/**
 * worker 侧的指标模块（M6-7）。
 *
 * ── 为什么是独立模块，而不是塞进 MetricsModule ──────────────────────────
 * MetricsModule 是 API 进程的（带 controller、带 /metrics、imports QueueModule），
 * 而这里只有两个 record 方法 + 一个独立的指标端口。把它俩放一起，worker 为了
 * 一个计数器会连带把 API 侧的东西（包括 QueueModule 的一整套队列生产者）
 * 拉进容器。
 *
 * ── 为什么标 @Global ────────────────────────────────────────────────────
 * 消费方有两个：`ProjectWorkerManager`（挂 completed/failed）和
 * `ErrorEventProcessor`（记 DLQ），都在 GroupingModule 里。标全局之后，
 * 以后任何新模块想埋点都不必改 imports。
 *
 * ── 端口 ────────────────────────────────────────────────────────────────
 * `WorkerMetricsServerService` 会在 `WORKER_METRICS_PORT`（默认 9464）上开一个
 * 只服务 `/metrics` 的 HTTP 端点 —— 归并指标只存在于 worker 进程内存里，
 * 不单独暴露的话 Prometheus 永远抓不到它们。
 *
 * 只有 worker 进程 import 它 —— API 进程没有归并任务，不需要这些计数。
 */
@Global()
@Module({
  providers: [WorkerMetricsService, WorkerMetricsServerService],
  exports: [WorkerMetricsService],
})
export class WorkerMetricsModule {}
