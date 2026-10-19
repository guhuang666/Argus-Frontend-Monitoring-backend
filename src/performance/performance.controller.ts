import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { extractIngestKey } from '../common/ingest-key';
import { TenantPageQueryDto } from '../common/dto/tenant-query.dto';
import { KeysService } from '../keys/keys.service';
import { IngestPerfDto } from './dto/ingest-perf.dto';
import { PerformanceService } from './performance.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestPerfResult } from './performance.service';

/**
 * 性能指标：上报 + 查询。
 *
 * 同一资源同一路径，靠 HTTP 方法区分动作：
 *   POST /api/v1/performance   上报一条（公钥鉴权：X-Argus-Key 或 ?key=）
 *   GET  /api/v1/performance?projectId=...  分页查询（管理侧，S4 起改挂 JWT）
 *
 * 单独一组路由而不是塞进 error 那边：两套数据形状不同，共用入口时
 * ValidationPipe 的 whitelist 会把对方的字段**静默剥掉**（不报错、数据凭空消失），
 * 最后落入一条字段全空的记录。形状不同，就该有两个入口。
 */
@Controller('api/v1')
export class PerformanceController {
  constructor(
    private readonly service: PerformanceService,
    private readonly keys: KeysService,
  ) {}

  /**
   * POST /api/v1/performance
   * 一次页面加载发一条（LCP / CLS / INP 三项 + 归因）。
   */
  @Post('performance')
  async store(@Body() body: IngestPerfDto, @Req() req: Request): Promise<IngestPerfResult> {
    const projectId = await this.keys.resolveProjectByPublicKey(extractIngestKey(req));
    return this.service.ingest(body, projectId);
  }

  /**
   * GET /api/v1/performance?projectId=&page=&pageSize=
   * 分页查询性能指标，按事件时间倒序，返回 { items, total, page, pageSize }。
   */
  @Get('performance')
  list(@Query() query: TenantPageQueryDto) {
    return this.service.listPerformanceMetrics(query.projectId, query.page, query.pageSize);
  }
}
