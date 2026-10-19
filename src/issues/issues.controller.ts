import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectScopeGuard } from '../auth/project-scope.guard';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { TenantQueryDto } from '../common/dto/tenant-query.dto';
import { ListIssuesQueryDto } from './dto/list-issues-query.dto';
import { UpdateIssueStatusDto } from './dto/update-issue-status.dto';
import { IssuesService } from './issues.service';

/**
 * 问题（归并后的实体）：列表 / 详情 / 状态流转。
 *
 * ── 这是 M2「问题管理」那一半 ────────────────────────────────────────────
 * 归并引擎（grouping/）负责把事件聚合成问题；本控制器负责把人需要看的东西
 * 读出来，并允许人改状态。两者不互相 import。
 *
 * ── 路由前缀：为什么是 ?projectId= 而不是 /projects/:id/issues ────────────
 * SRS §8 定的是后者。这里先用查询参数，理由有两条：
 *   ① 与 GET /error、GET /performance 保持一致 —— 三个读接口用同一种方式
 *      表达"看哪个项目"，看板只需要一处拼接逻辑
 *   ② S4 上 JWT 之后，"我在看哪个项目"会变成**服务端由身份推导**的事，
 *      路由前缀里那个 :projectId 反而要额外校验"它确实属于我"
 * 真正落地多租户路由时，这里一次性改成前缀即可，service 签名不用再动。
 *
 * ── 为什么 id 用 ParseUUIDPipe ──────────────────────────────────────────
 * id 列是 UUID。传个 "abc" 进去，Prisma 会在参数校验阶段抛错 → 变成 500。
 * 走 ParseUUIDPipe 就在进入 service 之前变成 **400**，语义才对。
 *
 * ── 为什么只在 API 进程注册 ─────────────────────────────────────────────
 * 见 issues.module.ts 的说明：worker 进程不该有管理接口。
 */
@Controller('api/v1/issues')
export class IssuesController {
  constructor(private readonly service: IssuesService) {}

  /**
   * GET /api/v1/issues?projectId=&page=&pageSize=&status=
   * 问题列表，按最近出现时间倒序。status 可选，不传 = 全部状态。
   */
  @Get()
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  list(@Query() query: ListIssuesQueryDto) {
    return this.service.listIssues(query);
  }

  /**
   * GET /api/v1/issues/:id?projectId=&page=&pageSize=
   * 问题详情 + 该问题下的事件（分页）。
   *
   * 问题不存在、或属于别的项目 → **都是 404**（不是 403）。
   * 403 等于告诉对方"这个 id 确实存在，只是不归你"，那把 id 逐个试一遍
   * 就能数出别人有几个问题。404 让"不存在"和"无权"不可区分。
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() tenant: TenantQueryDto,
    @Query() query: PageQueryDto,
  ) {
    return this.service.getIssue(id, tenant.projectId, query);
  }

  /**
   * PATCH /api/v1/issues/:id?projectId=
   * body: { "status": "resolved" }  —— 取值限 unresolved / resolved / ignored / archived
   *
   * 用 PATCH 而不是 PUT：只改 status 这一个字段，其余字段一个都不动。
   * 返回 { issue, changed }，changed=false 表示状态本来就是这个值（幂等）。
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() tenant: TenantQueryDto,
    @Body() body: UpdateIssueStatusDto,
  ) {
    return this.service.updateStatus(id, tenant.projectId, body);
  }
}
