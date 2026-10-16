import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { ErrorEventsController } from './error-events.controller';
import { ErrorEventsService } from './error-events.service';

/**
 * 异常事件接收与查询。
 *
 * 不再 imports MongooseModule.forFeature：数据访问走 PrismaService，
 * 它由标了 @Global 的 PrismaModule 提供，业务模块不必显式声明。
 *
 * W3 起 imports QueueModule：ingest 写库成功后要往归并队列投一条 job。
 * 注意这里只用到"投递"能力（Queue），消费在 worker.ts 那套进程里
 * —— 见 grouping.module.ts 的警告。
 */
@Module({
  imports: [QueueModule],
  controllers: [ErrorEventsController],
  providers: [ErrorEventsService],
  exports: [ErrorEventsService],
})
export class ErrorEventsModule {}
