import { Module } from '@nestjs/common';
import { ErrorEventsController } from './error-events.controller';
import { ErrorEventsService } from './error-events.service';

/**
 * 异常事件接收与查询。
 *
 * 不再 imports MongooseModule.forFeature：数据访问走 PrismaService，
 * 它由标了 @Global 的 PrismaModule 提供，业务模块不必显式声明。
 */
@Module({
  controllers: [ErrorEventsController],
  providers: [ErrorEventsService],
  exports: [ErrorEventsService],
})
export class ErrorEventsModule {}
