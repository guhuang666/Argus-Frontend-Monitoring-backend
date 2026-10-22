import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * 概览统计（批次 C）。
 *
 * 与 issues / performance 一样：只有 API 进程需要它，绝不进 worker 的 WorkerModule。
 * 不声明 imports —— PrismaService 由 @Global 的 PrismaModule 提供，
 * 鉴权守卫由 @Global 的 AuthModule 提供。
 */
@Module({
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
