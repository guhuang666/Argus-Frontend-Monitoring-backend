import { Body, Controller, Post } from '@nestjs/common';
import { IngestPerfDto } from './dto/ingest-perf.dto';
import { PerformanceService } from './performance.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestPerfResult } from './performance.service';

/**
 * 接收 SDK 上报的性能指标。
 *
 * 单独一个路由而不是塞进 /api/store：那个接口的 DTO 只认错误事件的字段，
 * 而 ValidationPipe 开了 whitelist —— 性能字段会被**静默剥掉**（不报错、数据凭空消失），
 * 最后落入一条 type/message 为空的错误记录。两套数据形状不同，就该有两个入口。
 */
@Controller('api')
export class PerformanceController {
  constructor(private readonly service: PerformanceService) {}

  /**
   * POST /api/performance
   * 一次页面加载发一条（LCP / CLS / INP 三项 + 归因）。
   * 这里还没有公钥校验、限流与削峰（后续里程碑）。
   */
  @Post('performance')
  async store(@Body() body: IngestPerfDto): Promise<IngestPerfResult> {
    return this.service.ingest(body);
  }
}
