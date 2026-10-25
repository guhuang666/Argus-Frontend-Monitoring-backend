import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectScopeGuard } from '../auth/project-scope.guard';
import { TenantPageQueryDto } from '../common/dto/tenant-query.dto';
import { IngestProject } from '../ratelimit/ingest-context';
import type { IngestContext } from '../ratelimit/ingest-context';
import { IngestRateLimitGuard } from '../ratelimit/ingest-rate-limit.guard';
import { IngestPerfDto } from './dto/ingest-perf.dto';
import { PerformanceService } from './performance.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestPerfResult } from './performance.service';

/**
 * 性能指标：上报 + 查询。
 *
 * 同一资源同一路径，靠 HTTP 方法区分动作：
 *   POST /api/v1/performance   上报一条（公钥鉴权 + 限流）
 *   GET  /api/v1/performance?projectId=...  分页查询（管理侧，S4 起改挂 JWT）
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
   *
   * 与 POST /error 共用同一个 `IngestRateLimitGuard`：
   * 两个入口如果只限一个，攻击者换个路径就绕过去了。
   * 它们共享同一本账（key 里带 projectId，不带路由名），
   * 所以「错误 + 性能」加起来算一个项目的总额度。
   */
  @Post('performance')
  @UseGuards(IngestRateLimitGuard)
  async store(
    @Body() body: IngestPerfDto,
    @IngestProject() project: IngestContext,
    // 同 POST /error：pino-http 在请求对象上挂了 `id`（M6-6）。
    // 性能上报目前不入队，所以这串 id 只用于把这条上报的日志和访问日志对齐
    @Req() req: { id?: string },
  ): Promise<IngestPerfResult> {
    return this.service.ingest(body, project.projectId, req.id);
  }

  /**
   * GET /api/v1/performance?projectId=&page=&pageSize=
   * 分页查询性能指标，按事件时间倒序，返回 { items, total, page, pageSize }。
   *
   * 与 GET /error 同样：S4 起需要登录 + 项目归属校验。
   */
  @Get('performance')
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  list(@Query() query: TenantPageQueryDto) {
    return this.service.listPerformanceMetrics(query.projectId, query.page, query.pageSize);
  }
}
