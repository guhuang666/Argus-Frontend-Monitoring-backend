import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';

/**
 * 性能指标（LCP / CLS / INP）的接收与查询。
 *
 * imports SessionsModule：性能上报同时是"页面加载了一次"的证据，
 * 入库后顺手给会话的 page_views +1（PV 的现有口径，见 Session 模型注释）。
 */
@Module({
  imports: [SessionsModule],
  controllers: [PerformanceController],
  providers: [PerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
