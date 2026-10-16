import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IngestPerfDto } from './dto/ingest-perf.dto';
import { PerformanceService } from './performance.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestPerfResult } from './performance.service';

/**
 * 分页参数。
 *
 * 与 error-events.controller.ts 里的同名类保持一致（本阶段约定不新增文件，
 * 所以只能各留一份副本）；改动请同步两边。
 *
 * ⚠️ @Type(() => Number) 不能省：全局 ValidationPipe 关掉了
 * enableImplicitConversion，query 参数到手是字符串，"2" 过不了 @IsInt()。
 */
class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

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
