import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectScopeGuard } from '../auth/project-scope.guard';
import { OverviewQueryDto } from './dto/overview-query.dto';
import { StatsService } from './stats.service';

/**
 * 概览统计。
 *
 * GET /api/v1/stats/overview?projectId=&range=24h
 *
 * ── 为什么是 `?projectId=` 而不是 `/projects/:projectId/stats/overview` ──
 * SRS §8 写的是路径前缀式。但当前三个读接口（/error、/issues、/performance）
 * 全都是查询参数式，看板也只有一种拼参逻辑。这里跟随现状，避免同一种"看哪个
 * 项目"在一半接口上是路径、在另一半上是参数 —— 那种不一致最容易写成 bug。
 * 守卫 `extractProjectId()` 两种都认，将来整体改成前缀时这里不用动 service。
 *
 * ── 守卫的顺序 ──────────────────────────────────────────────────────────
 * JwtAuthGuard 先跑（它往 request 上挂 user），ProjectScopeGuard 后跑
 * （它读 user.orgId 判断项目归属）。写反了会拿到 user === undefined，
 * 结果是 401 而不是越权 404 —— 方向安全但原因误导，别调换。
 */
@Controller('api/v1/stats')
export class StatsController {
  constructor(private readonly service: StatsService) {}

  @Get('overview')
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  overview(@Query() query: OverviewQueryDto) {
    return this.service.overview(query.projectId, query.range);
  }
}
