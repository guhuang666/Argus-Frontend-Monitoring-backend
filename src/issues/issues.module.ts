import { Module } from '@nestjs/common';
import { IssuesController } from './issues.controller';
import { IssuesService } from './issues.service';

/**
 * 问题管理（M2 的读接口 + 状态流转）。
 *
 * ── 只被 app.module.ts import ───────────────────────────────────────────
 * **绝不进 worker.ts 的 WorkerModule**：本模块只有控制器和查询，没有消费者，
 * 但进程分工要一直保持干净 —— API 进程管接口，worker 进程管归并。
 * 反过来说，grouping.module.ts 也绝不进 app.module.ts，两边互不越界。
 *
 * ── 依赖 ────────────────────────────────────────────────────────────────
 * 不声明 imports：PrismaService 由标了 @Global 的 PrismaModule 提供
 * （同 error-events.module.ts 的写法）。
 */
@Module({
  controllers: [IssuesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}
