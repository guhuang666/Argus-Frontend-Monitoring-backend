import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ErrorEventsService, IngestPayload, IngestResult } from './error-events.service';

/** 接收 SDK 上报的异常事件 */
@Controller('api')
export class ErrorEventsController {
  constructor(private readonly service: ErrorEventsService) {}

  /**
   * POST /api/store
   * 对应 SRS §8 的上报入口。这里还没有公钥校验、限流与削峰（后续里程碑）。
   */
  @Post('store')
  async store(@Body() body: IngestPayload): Promise<IngestResult> {
    // 上游可能发来任何东西，先卡住最小必需字段
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('请求体必须是 JSON 对象');
    }
    if (typeof body.event_id !== 'string' || body.event_id.length === 0 || body.event_id.length > 128) {
      throw new BadRequestException('event_id 缺失或非法');
    }
    if (typeof body.message !== 'string' || body.message.length === 0) {
      throw new BadRequestException('message 缺失');
    }
    if (body.mechanism !== 'onerror' && body.mechanism !== 'unhandledrejection') {
      throw new BadRequestException('mechanism 必须是 onerror 或 unhandledrejection');
    }

    return this.service.ingest(body);
  }
}
