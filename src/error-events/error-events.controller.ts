import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { extractIngestKey } from '../common/ingest-key';
import { TenantPageQueryDto } from '../common/dto/tenant-query.dto';
import { KeysService } from '../keys/keys.service';
import { IngestErrorDto } from './dto/ingest-error.dto';
import { ErrorEventsService } from './error-events.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestResult } from './error-events.service';

/**
 * 异常事件：上报 + 查询。
 *
 * 同一资源同一路径，靠 HTTP 方法区分动作：
 *   POST /api/v1/error   上报一条（公钥鉴权：X-Argus-Key 或 ?key=）
 *   GET  /api/v1/error?projectId=...  分页查询（管理侧，S4 起改挂 JWT）
 *
 * `api/v1` 统一放在 @Controller 前缀上，路由字符串里不再重复写 v1 ——
 * 也就不会再出现"新加路由忘了带 v1"这种事（SRS §8 要求统一前缀）。
 */
@Controller('api/v1')
export class ErrorEventsController {
  constructor(
    private readonly service: ErrorEventsService,
    private readonly keys: KeysService,
  ) {}

  /**
   * POST /api/v1/error
   *
   * ── 鉴权顺序：先认钥匙，再校验字段体 ────────────────────────────────────
   * ValidationPipe 是对 @Body 生效的，会先于方法体执行 —— 也就是说"格式不合法的
   * 未鉴权请求"会先拿到 400 而不是 401。这个顺序是有意的（便宜的事先做），
   * 但它确实泄漏了"这条路由接受什么形状"，对上报接口无所谓。
   *
   * ── projectId 不再由 DTO 决定 ──────────────────────────────────────────
   * 客户端发的任何 project_id 字段都不会被采信：项目身份只来自钥匙。
   * 这是 TC-05 的核心 —— 隔离由数据访问层强制的 projectId 决定，
   * 而不是由"请求里带了什么"决定。
   */
  @Post('error')
  async store(@Body() body: IngestErrorDto, @Req() req: Request): Promise<IngestResult> {
    const projectId = await this.keys.resolveProjectByPublicKey(extractIngestKey(req));
    return this.service.ingest(body, projectId);
  }

  /**
   * GET /api/v1/error?projectId=&page=&pageSize=
   * 分页查询异常事件，按事件时间倒序，返回 { items, total, page, pageSize }。
   *
   * 想看"归并后的结果"请用 GET /api/v1/issues —— 那是 M2 的问题列表；
   * 本接口的用途是"看原始事件明细"，也是问题详情页下钻的兜底。
   */
  @Get('error')
  list(@Query() query: TenantPageQueryDto) {
    return this.service.listErrorEvents(query.projectId, query.page, query.pageSize);
  }
}
