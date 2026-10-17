import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { PageQueryDto } from '../common/dto/page-query.dto';
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
 * ── 路由前缀 ────────────────────────────────────────────────────────────
 * MVP 去掉了 project_id，所以是 `/api/v1/issues`，而不是 SRS §8 的
 * `/projects/:id/issues`。等加回多项目，把 projectId 拼回前缀即可，
 * service 里只多一个 where 字段。
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
   * GET /api/v1/issues?page=&pageSize=&status=
   * 问题列表，按最近出现时间倒序。status 可选，不传 = 全部状态。
   */
  @Get()
  list(@Query() query: ListIssuesQueryDto) {
    return this.service.listIssues(query);
  }

  /**
   * GET /api/v1/issues/:id?page=&pageSize=
   * 问题详情 + 该问题下的事件（分页）。问题不存在 → 404。
   */
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string, @Query() query: PageQueryDto) {
    return this.service.getIssue(id, query);
  }

  /**
   * PATCH /api/v1/issues/:id
   * body: { "status": "resolved" }  —— 取值限 unresolved / resolved / ignored / archived
   *
   * 用 PATCH 而不是 PUT：只改 status 这一个字段，其余字段一个都不动。
   * 返回 { issue, changed }，changed=false 表示状态本来就是这个值（幂等）。
   */
  @Patch(':id')
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateIssueStatusDto) {
    return this.service.updateStatus(id, body);
  }
}
