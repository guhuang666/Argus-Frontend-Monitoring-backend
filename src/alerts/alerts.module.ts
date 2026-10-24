import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

/**
 * 告警规则（M6-2）。
 *
 * 只有 API 进程需要它：CRUD 是人在设置页上的动作，worker 不碰配置。
 * 反过来，M6-3 的评估器只进 worker 进程 —— 这条分工和 grouping/ 一模一样：
 * **谁消费、谁写，谁就单独有一个模块**，API 进程绝不 import 带 @Processor 的东西。
 *
 * 不声明 imports：PrismaService 由 @Global 的 PrismaModule 提供，
 * 两个守卫由 @Global 的 AuthModule 提供。
 */
@Module({
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}
