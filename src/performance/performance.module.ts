import { Module } from '@nestjs/common';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';

/** 性能指标（LCP / CLS / INP）的接收与查询 */
@Module({
  imports: [],
  controllers: [PerformanceController],
  providers: [PerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
