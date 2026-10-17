import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { IngestPerfDto } from './dto/ingest-perf.dto';
import { PerformanceService } from './performance.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestPerfResult } from './performance.service';

/**
 * 性能指标：上报 + 查询。
 *
 * 同一资源同一路径，靠 HTTP 方法区分动作：
 *   POST /api/v1/performance   上报一条（公开，将来用公钥 X-Argus-Key 鉴权）
 *   GET  /api/v1/performance   分页查询（管理侧，将来挂 JWT）
 *
 * 单独一组路由而不是塞进 error 那边：两套数据形状不同，共用入口时
 * ValidationPipe 的 whitelist 会把对方的字段**静默剥掉**（不报错、数据凭空消失），
 * 最后落入一条字段全空的记录。形状不同，就该有两个入口。
 *
 * 分页参数：原先本文件里有一份 PageQueryDto 副本，issues 成为第 3 个读接口后
 * 按注释里的约定抽到了 common/dto/page-query.dto.ts，这里改为 import。
 */
@Controller('api/v1')
export class PerformanceController {
  constructor(private readonly service: PerformanceService) {}

  /**
   * POST /api/v1/performance
   * 一次页面加载发一条（LCP / CLS / INP 三项 + 归因）。
   * 这里还没有公钥校验、限流与削峰（后续里程碑）。
   */
  @Post('performance')
  async store(@Body() body: IngestPerfDto): Promise<IngestPerfResult> {
    return this.service.ingest(body);
  }

  /**
   * GET /api/v1/performance?page=&pageSize=
   * 分页查询性能指标，按事件时间倒序，返回 { items, total, page, pageSize }。
   *
   * 过渡接口：暂时没有 projectId 过滤（表里还没有 project_id 列）。
   */
  @Get('performance')
  list(@Query() query: PageQueryDto) {
    return this.service.listPerformanceMetrics(query.page, query.pageSize);
  }
}
