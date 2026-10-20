import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectScopeGuard } from '../auth/project-scope.guard';
import { TenantPageQueryDto } from '../common/dto/tenant-query.dto';
import { IngestProject } from '../ratelimit/ingest-context';
import type { IngestContext } from '../ratelimit/ingest-context';
import { IngestRateLimitGuard } from '../ratelimit/ingest-rate-limit.guard';
import { IngestErrorDto } from './dto/ingest-error.dto';
import { ErrorEventsService } from './error-events.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestResult } from './error-events.service';

/**
 * 异常事件：上报 + 查询。
 *
 * 同一资源同一路径，靠 HTTP 方法区分动作：
 *   POST /api/v1/error   上报一条（公钥鉴权：请求头 X-Argus-Key）
 *   GET  /api/v1/error?projectId=...  分页查询（管理侧，S4 起改挂 JWT）
 *
 * `api/v1` 统一放在 @Controller 前缀上，路由字符串里不再重复写 v1 ——
 * 也就不会再出现"新加路由忘了带 v1"这种事（SRS §8 要求统一前缀）。
 */
@Controller('api/v1')
export class ErrorEventsController {
  constructor(private readonly service: ErrorEventsService) {}

  /**
   * POST /api/v1/error
   *
   * ── 鉴权 + 限流都在守卫里 ──────────────────────────────────────────────
   * `IngestRateLimitGuard` 做三件事：
   *   ① 解析公钥 → projectId（同时取出该项目的每秒上限）
   *   ② 滑动窗口检查（Redis + Lua），超了回 429 + `Retry-After`
   *   ③ 把结果挂到 request 上，控制器用 `@IngestProject()` 取
   *
   * 所以方法体里不再有"这是哪个项目"的逻辑 —— 它已经被守卫确定下来了。
   *
   * ── projectId 不由 DTO 决定 ────────────────────────────────────────────
   * 客户端发的任何 project_id 字段都不会被采信：项目身份只来自钥匙。
   * 这是 TC-05 的核心 —— 隔离由数据访问层强制的 projectId 决定，
   * 而不是由"请求里带了什么"决定。
   */
  @Post('error')
  @UseGuards(IngestRateLimitGuard)
  async store(
    @Body() body: IngestErrorDto,
    @IngestProject() project: IngestContext,
  ): Promise<IngestResult> {
    return this.service.ingest(body, project.projectId);
  }

  /**
   * GET /api/v1/error?projectId=&page=&pageSize=
   * 分页查询异常事件，按事件时间倒序，返回 { items, total, page, pageSize }。
   *
   * S4 起需要登录（JWT），且 projectId 必须属于你所在的某个组织。
   * 两个守卫的分工见 auth/ 里的注释：前者认证（你是谁），后者授权（你能看哪个项目）。
   *
   * 想看"归并后的结果"请用 GET /api/v1/issues —— 那是 M2 的问题列表；
   * 本接口的用途是"看原始事件明细"，也是问题详情页下钻的兜底。
   */
  @Get('error')
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  list(@Query() query: TenantPageQueryDto) {
    return this.service.listErrorEvents(query.projectId, query.page, query.pageSize);
  }
}
