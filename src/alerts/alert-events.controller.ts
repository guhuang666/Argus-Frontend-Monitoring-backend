import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectScopeGuard } from '../auth/project-scope.guard';
import { AlertsService } from './alerts.service';
import { ListAlertEventsQueryDto } from './dto/list-alert-events-query.dto';

/**
 * 告警触发历史（M6-5）。
 *
 *   GET /api/v1/alert-events?projectId=&page=&pageSize=
 *       &ruleId=           只看某条规则
 *       &delivered=true    只看投递成功 / false 只看失败
 *       &from=&to=         按触发时刻过滤（ISO 8601，[from, to)）
 *
 * ── 为什么单独一个控制器 ────────────────────────────────────────────────
 * 它和 `/alert-rules` 是两种资源（配置 vs 记录），共用控制器就要在一个
 * @Controller 前缀下挂两种路径，守卫注释也得写两遍。拆开之后，
 * 将来给历史加"导出 CSV""删除过期记录"也不会污染规则的控制器。
 *
 * 守卫顺序同别处：JwtAuthGuard 先（挂 user），ProjectScopeGuard 后（查归属）。
 */
@Controller('api/v1/alert-events')
export class AlertEventsController {
  constructor(private readonly service: AlertsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  list(@Query() query: ListAlertEventsQueryDto) {
    return this.service.listEvents(query);
  }
}
