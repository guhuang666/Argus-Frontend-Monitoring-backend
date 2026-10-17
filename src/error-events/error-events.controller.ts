import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { IngestErrorDto } from './dto/ingest-error.dto';
import { ErrorEventsService } from './error-events.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestResult } from './error-events.service';

/**
 * 异常事件：上报 + 查询。
 *
 * 同一资源同一路径，靠 HTTP 方法区分动作：
 *   POST /api/v1/error   上报一条（公开，将来用公钥 X-Argus-Key 鉴权）
 *   GET  /api/v1/error   分页查询（管理侧，将来挂 JWT）
 *
 * `api/v1` 统一放在 @Controller 前缀上，路由字符串里不再重复写 v1 ——
 * 也就不会再出现"新加路由忘了带 v1"这种事（SRS §8 要求统一前缀）。
 *
 * 分页参数：原先本文件里有一份 PageQueryDto 副本，issues 成为第 3 个读接口后
 * 按注释里的约定抽到了 common/dto/page-query.dto.ts，这里改为 import。
 */
@Controller('api/v1')
export class ErrorEventsController {
  constructor(private readonly service: ErrorEventsService) {}

  /**
   * POST /api/v1/error
   * 对应 SRS §8 的上报入口。字段校验交给全局 ValidationPipe + IngestErrorDto。
   * 这里还没有公钥校验、限流与削峰（后续里程碑）。
   *
   * 注：SRS FR-2.1 的批量入口 POST /api/v1/envelope/:projectId 落地后，
   * 本条路由由它取代（届时同步改 sdk/index.ts 里的 ENDPOINT）。
   */
  @Post('error')
  async store(@Body() body: IngestErrorDto): Promise<IngestResult> {
    return this.service.ingest(body);
  }

  /**
   * GET /api/v1/error?page=&pageSize=
   * 分页查询异常事件，按事件时间倒序，返回 { items, total, page, pageSize }。
   *
   * 过渡接口：暂时没有 projectId 过滤（表里还没有 project_id 列）。
   * 想看"归并后的结果"请用 GET /api/v1/issues —— 那是 M2 的问题列表；
   * 本接口的用途是"看原始事件明细"，也是问题详情页下钻的兜底。
   */
  @Get('error')
  list(@Query() query: PageQueryDto) {
    return this.service.listErrorEvents(query.page, query.pageSize);
  }
}
