import { Module } from '@nestjs/common';
import { ErrorEventProcessor } from './error-event.processor';
import { QueueModule } from '../queue/queue.module';

/**
 * 归并（M2）—— 消息归一化、指纹、问题聚合。
 *
 * ── ⚠ 不要把本模块注册进 app.module.ts ──────────────────────────────────
 * 它带 ErrorEventProcessor，而 @Processor 装饰过的 provider 一被实例化，
 * **那个进程就开始消费队列**。API 进程一旦引入本模块，就变成"HTTP 进程也在抢 job
 * 跑归并"：进程分工（W3 的 curl 验收就是两个终端）和后面的横向扩容全乱套。
 * 消费只属于 worker.ts。
 *
 * ── 现在谁在用它 ────────────────────────────────────────────────────────
 * 只有 WorkerModule（src/worker.ts）import 它。Web 侧暂时用不到归并能力。
 *
 * ── 目录里的纯函数 ──────────────────────────────────────────────────────
 * normalize.ts 与 fingerprint.ts 都是纯函数，不依赖 Nest 容器，不需要在这里注册。
 */
@Module({
  imports: [QueueModule],
  providers: [ErrorEventProcessor],
  exports: [ErrorEventProcessor],
})
export class GroupingModule {}
