import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ErrorEvent, ErrorEventSchema } from './error-event.schema';
import { ErrorEventsController } from './error-events.controller';
import { ErrorEventsService } from './error-events.service';

/** 异常事件接收与查询 */
@Module({
  imports: [MongooseModule.forFeature([{ name: ErrorEvent.name, schema: ErrorEventSchema }])],
  controllers: [ErrorEventsController],
  providers: [ErrorEventsService],
  exports: [ErrorEventsService],
})
export class ErrorEventsModule {}
