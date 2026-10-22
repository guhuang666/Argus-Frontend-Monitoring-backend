import { IsIn } from 'class-validator';
import { TenantQueryDto } from '../../common/dto/tenant-query.dto';

/**
 * 概览页支持的时间范围。
 *
 * ── 为什么没有 1h ────────────────────────────────────────────────────────
 * 趋势读的是 `issue_stats_hourly`，它最细的粒度就是**小时**。1 小时的窗口
 * 落在这种表上只会有 1~2 个点，折线退化成两个端点，没有任何信息量。
 * 真要做 1h 只能改读 `error_events` 明细——那会违反 TC-12（趋势/概览一律读
 * 预聚合表），而且为了一个"看不出趋势"的视图开这个口子不值得。
 * 需要更细的排查时，用「异常」页看明细，那是另一条路径。
 */
export const OVERVIEW_RANGES = ['24h', '7d', '30d'] as const;

export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

/** range → 窗口长度（毫秒）。服务端算窗口用，前端不参与 */
export const RANGE_MS: Record<OverviewRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * GET /api/v1/stats/overview 的查询参数。
 *
 * 继承 TenantQueryDto 而不是再写一遍 `@IsUUID() projectId`：
 * 租户参数只有一份定义，将来改成"从 JWT 推导、query 可省略"时只改基类。
 *
 * range 有默认值 '24h'：概览页打开的第一眼就该有东西看，
 * 而不是先让用户选一个范围才发请求。
 */
export class OverviewQueryDto extends TenantQueryDto {
  // 展开成数组再传给 @IsIn：它要的是可变数组，readonly 元组在类型上不兼容
  @IsIn([...OVERVIEW_RANGES])
  range: OverviewRange = '24h';
}
