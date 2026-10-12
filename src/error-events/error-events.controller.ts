import { Body, Controller, Post } from '@nestjs/common';
import { IngestErrorDto } from './dto/ingest-error.dto';
import { ErrorEventsService } from './error-events.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestResult } from './error-events.service';

/** 接收 SDK 上报的异常事件 */
@Controller('api')
export class ErrorEventsController {
  constructor(private readonly service: ErrorEventsService) {}

  /**
   * POST /api/store
   * 对应 SRS §8 的上报入口。字段校验交给全局 ValidationPipe + IngestErrorDto。
   * 这里还没有公钥校验、限流与削峰（后续里程碑）。
   */
  @Post('store')
  async store(@Body() body: IngestErrorDto): Promise<IngestResult> {
    return this.service.ingest(body);
  }
}
