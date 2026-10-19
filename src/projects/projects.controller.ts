import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectScopeGuard } from '../auth/project-scope.guard';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectsService } from './projects.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * 项目：列表 / 详情 / 新建。（M4-S2 建立，M4-S4 加鉴权，MVP-B 加创建）
 *
 *   GET  /api/v1/projects              我组织下的项目（看板切换器 + 公钥）
 *   GET  /api/v1/projects/:projectId   单个项目 + 全部有效公钥
 *   POST /api/v1/projects              新建项目，返回一次性私钥
 *
 * ── 三条路由用哪种"项目作用域" ──────────────────────────────────────────
 *   列表：没有单个项目，靠 JWT 里的 orgId 过滤 → 只用 JwtAuthGuard
 *   详情：URL 里有 :projectId → 加 ProjectScopeGuard（不属于我 → 404）
 *   新建：还没有项目 → 只用 JwtAuthGuard（+ service 里的角色判断）
 *
 * ── 为什么详情路由的参数叫 :projectId 而不是 :id ───────────────────────
 * ProjectScopeGuard 从 params.projectId 取要校验的项目。
 * 名字对不上的话守卫会认为"没传项目"，直接 400 ——
 * 统一命名是让守卫能被无脑复用（而不是每个控制器记一个特例）的前提。
 */
@Controller('api/v1/projects')
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.orgId);
  }

  @Get(':projectId')
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  detail(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.service.getById(projectId);
  }

  /**
   * POST /api/v1/projects
   * body: { "name": "商城 Web", "platform": "browser" }
   *
   * 201 { project: {...}, secret_key_once: "argus_sec_..." }
   *
   * 注意 `secret_key_once` **只有这一次**。前端必须当场让用户复制走，
   * 之后库里只有 sha256，谁也读不回来（包括运维）。
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: AuthUser, @Body() body: CreateProjectDto) {
    return this.service.create(user.orgId, user.role, body);
  }
}
