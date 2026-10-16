import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IngestErrorDto } from './dto/ingest-error.dto';
import { ErrorEventsService } from './error-events.service';
// interface 只用于类型，在装饰器签名里必须用 import type，
// 否则 isolatedModules + emitDecoratorMetadata 会报错
import type { IngestResult } from './error-events.service';

/**
 * 分页参数。
 *
 * 为什么这个类定义在 controller 里而不是 dto/ 目录：本阶段约定不新增文件。
 * performance.controller.ts 里有一份相同副本 —— 改动请同步两边；
 * 出现第 3 个读接口时，就是把它抽到共享位置的时机。
 *
 * ⚠️ @Type(() => Number) 不能省：main.ts 里的 ValidationPipe 关掉了
 * enableImplicitConversion，query 参数到手是字符串，"2" 过不了 @IsInt()。
 */
class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

/**
 * 异常事件：上报 + 查询。
 *
 * 同一资源同一路径，靠 HTTP 方法区分动作：
 *   POST /api/v1/error   上报一条（公开，将来用公钥 X-Argus-Key 鉴权）
 *   GET  /api/v1/error   分页查询（管理侧，将来挂 JWT）
 *
 * `api/v1` 统一放在 @Controller 前缀上，路由字符串里不再重复写 v1 ——
 * 也就不会再出现"新加路由忘了带 v1"这种事（SRS §8 要求统一前缀）。
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
   * 过渡接口：暂时没有 projectId 过滤（表里还没有 project_id 列），
   * 目的只是把已经上报的数据读出来。M2 引入 error_groups / project_id 后，
   * 由 /api/v1/projects/:projectId/issues 取代。
   */
  @Get('error')
  list(@Query() query: PageQueryDto) {
    return this.service.listErrorEvents(query.page, query.pageSize);
  }
}
