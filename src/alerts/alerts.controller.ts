import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectScopeGuard } from '../auth/project-scope.guard';
import { TenantQueryDto } from '../common/dto/tenant-query.dto';
import { AlertsService } from './alerts.service';
import { CreateAlertRuleDto } from './dto/create-alert-rule.dto';
import { UpdateAlertRuleDto } from './dto/update-alert-rule.dto';

/**
 * 告警规则的 CRUD（M6-2）。
 *
 *   GET    /api/v1/alert-rules?projectId=          列表
 *   POST   /api/v1/alert-rules?projectId=          新建
 *   PATCH  /api/v1/alert-rules/:id?projectId=      局部更新（含开关）
 *   DELETE /api/v1/alert-rules/:id?projectId=      删除
 *
 * ── 为什么 projectId 在 query 而不是路径里 ──────────────────────────────
 * 与 issues / performance / error / stats 四个读接口保持一致。
 * SRS §8 写的是 `/projects/:id/alert-rules`，但同一个"看哪个项目"如果
 * 一半接口用路径、一半用参数，看板侧就要写两套拼参逻辑——那是最容易写错的地方。
 * 守卫两种都认，将来整体换成路径前缀时，这里只改装饰器，service 不动。
 *
 * ── 顺序：JwtAuthGuard 必须在 ProjectScopeGuard 之前 ─────────────────────
 * 后者依赖前者挂上去的 request.user。写反了会得到 401（方向安全但信息误导）。
 */
@Controller('api/v1/alert-rules')
export class AlertsController {
  constructor(private readonly service: AlertsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  list(@Query() query: TenantQueryDto) {
    return this.service.list(query.projectId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  create(@Query() query: TenantQueryDto, @Body() body: CreateAlertRuleDto) {
    return this.service.create(query.projectId, body);
  }

  /**
   * 局部更新。界面上有两个入口：
   *   · 行内开关 → 只发 `{ "enabled": false }`
   *   · 编辑弹窗 → 发全部可编辑字段
   * 两种请求走同一个接口，因为它们要改的是同一条规则，没有理由拆成两个路由。
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TenantQueryDto,
    @Body() body: UpdateAlertRuleDto,
  ) {
    return this.service.update(query.projectId, id, body);
  }

  /**
   * DELETE 用 204 而不是 200：没有响应体可以给，返回 `{}` 只是让前端多解析一次。
   *
   * ⚠ 删除是物理删除，不是 enabled=false。semantics 上二者不同：
   * "停用"是暂时不参与评估但保留配置，删除是连历史一起丢（外键 Cascade）。
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, ProjectScopeGuard)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TenantQueryDto,
  ): Promise<void> {
    await this.service.remove(query.projectId, id);
  }
}
