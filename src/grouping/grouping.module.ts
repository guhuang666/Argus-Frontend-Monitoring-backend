import { Module } from '@nestjs/common';
import { WorkerMetricsModule } from '../metrics/worker-metrics.module';
import { QueueModule } from '../queue/queue.module';
import { ErrorEventProcessor } from './error-event.processor';
import { ProjectWorkerManager } from './project-worker.manager';
import { SourcemapLookupService } from './sourcemap-lookup.service';

/**
 * 归并（M2）—— 消息归一化、指纹、问题聚合。
 *
 * ── ⚠ 不要把本模块注册进 app.module.ts ──────────────────────────────────
 * 它带 `ProjectWorkerManager`，而那个 provider 一被实例化就会**为每个项目
 * 创建 Worker、开始消费队列**。API 进程一旦引入本模块，就变成"HTTP 进程也在
 * 抢 job 跑归并"：进程分工（W3 的 curl 验收就是两个终端）和横向扩容全乱套。
 *
 * ── S7 之后多了什么 ────────────────────────────────────────────────────
 * 以前是 `@Processor('error-events')` 静态绑一条队列；现在换成
 * `ProjectWorkerManager` 按项目动态建 Worker（队列名 `error-events-<projectId>`）。
 * 消费逻辑本身（ErrorEventProcessor）没变，只是不再自己"监听"。
 *
 * ── 现在谁在用它 ────────────────────────────────────────────────────────
 * 只有 WorkerModule（src/worker.ts）import 它。
 *
 * ── 目录里的纯函数 ──────────────────────────────────────────────────────
 * normalize.ts 与 fingerprint.ts 都是纯函数，不依赖 Nest 容器，不需要在这里注册。
 */
@Module({
  imports: [QueueModule, WorkerMetricsModule],
  // SourcemapLookupService 只给 Worker 用（查 sourcemap_files + 读 uploads/），
  // 放在这里而不是 sourcemaps/：那个目录是 API 进程的上传侧，两边的依赖不该混
  providers: [ErrorEventProcessor, ProjectWorkerManager, SourcemapLookupService],
  exports: [ErrorEventProcessor, ProjectWorkerManager],
})
export class GroupingModule {}
