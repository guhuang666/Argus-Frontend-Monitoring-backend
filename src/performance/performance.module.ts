import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PerformanceMetric, PerformanceMetricSchema } from './performance-metric.schema';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';

/** 性能指标（LCP / CLS / INP）的接收与查询 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: PerformanceMetric.name, schema: PerformanceMetricSchema }]),
  ],
  controllers: [PerformanceController],
  providers: [PerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
