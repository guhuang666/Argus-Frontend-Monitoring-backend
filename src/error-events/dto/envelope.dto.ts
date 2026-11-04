import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { IngestErrorDto } from './ingest-error.dto';

/**
 * 单请求最多多少条事件。
 *
 * **必须与 SDK 的 `MAX_BATCH` 一致**（`Argus-Util/sdk/index.ts` 的 `MAX_BATCH = 50`）：
 * SDK 攒满 50 条就立刻发，永远不会发更多；后端把上限设成 50 是为了
 * 「客户端能发的」与「服务端肯收的」两份契约不会漂移。
 *
 * 为什么不是更大：一条请求的 body 上限是 1 MB，50 条 × 20 KB 刚好留出余量；
 * 再大则单个请求占用主线程过久，队列里其他请求的 P99 会被拖累。
 */
export const MAX_BATCH_EVENTS = 50;

/**
 * 批量上报的请求体：`POST /api/v1/error/batch`。
 *
 * 形状由 SDK 决定 —— `sendBatch()` 里写的是 `JSON.stringify({ events })`。
 *
 * ── 两个装饰器一个都不能少 ────────────────────────────────────────────────
 * `@ValidateNested({ each: true })` 才会**逐条**校验数组元素；
 * `@Type(() => IngestErrorDto)` 让 class-transformer 把纯 JSON 对象转成 DTO 实例，
 * 否则 `@ValidateNested` 拿到的是普通对象、装饰器上的校验规则一条都不生效
 * —— 表现为「字段长度超了却仍能入库」，比直接报错更难查。
 */
export class EnvelopeDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_EVENTS)
  @ValidateNested({ each: true })
  @Type(() => IngestErrorDto)
  events!: IngestErrorDto[];
}
