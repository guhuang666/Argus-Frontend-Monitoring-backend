import { Global, Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * 指标模块（M6-7 最小版）。
 *
 * ── 为什么标 @Global ────────────────────────────────────────────────────
 * `MetricsService` 会被上报服务（error-events）和限流守卫（ratelimit）
 * 各注入一次 —— 这两处都不是"指标"自己的模块。要么每个模块 imports 一遍，
 * 要么全局。与 AuthModule / RateLimitModule 同一个取舍：**横切能力用全局**，
 * 让"埋点"变成一个纯增量动作，不用改模块依赖图。
 *
 * ── 为什么 imports QueueModule ──────────────────────────────────────────
 * 队列积压指标要在抓取时去问 BullMQ 要数字，拿的是 ProjectQueueService。
 * 它由 QueueModule 提供并 export。
 *
 * ⚠️ 本模块只被 app.module.ts import：这是 **API 进程**的指标端点。
 * worker 进程的归并指标（job 尝试次数 / DLQ）在它自己的 registry 里，
 * 由 `WorkerMetricsServerService` 在 9464 端口单独暴露 —— 两个进程的内存
 * 不互通，跨进程中转只会多一条会失败的链路。
 */
@Global()
@Module({
  imports: [QueueModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
