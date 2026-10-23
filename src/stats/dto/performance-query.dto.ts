import { IsIn } from 'class-validator';
import { TenantQueryDto } from '../../common/dto/tenant-query.dto';
import { OVERVIEW_RANGES, type OverviewRange } from './overview-query.dto';

/**
 * 性能趋势支持的核心指标（FR-2 / M5）。
 *
 * 三个都是 `performance_metrics` 上的**列名**，而且必须是列名 —— 见
 * `StatsService.performanceTrend` 里那段"为什么列名不能参数化"的注释。
 *
 * 这里只有三个 Web Vitals 主指标，不含 FCP/TTFB：
 *   · FCP/TTFB 库里根本没有列（表结构只存了 lcp/cls/inp），选了也是 500
 *   · 这两个值的诊断价值被 LCP 覆盖了大半，真要看 TTFT 类问题走「慢请求」那条线
 * 宁可给三个能用的，也不给五个里两个必炸的。
 */
export const PERF_METRICS = ['lcp', 'cls', 'inp'] as const;

export type PerfMetric = (typeof PERF_METRICS)[number];

/**
 * GET /api/v1/stats/performance 的查询参数。
 *
 * range 直接复用概览那套 `OVERVIEW_RANGES`，不另定义一份：
 * 「看多长时间」在两个页面上是同一个概念，两份枚举迟早会漂移
 * （比如概览加了 90d、性能页忘了加，前端下拉框就会有一项必然 400）。
 *
 * 两个字段都有默认值，理由和概览一致：页面打开的第一眼就该有东西看，
 * 而不是先让用户选一轮才发请求。默认指标选 lcp —— 它最直观对应"页面慢"。
 */
export class PerformanceQueryDto extends TenantQueryDto {
  // 展开成数组再传给 @IsIn：它要的是可变数组，readonly 元组在类型上不兼容
  @IsIn([...PERF_METRICS])
  metric: PerfMetric = 'lcp';

  @IsIn([...OVERVIEW_RANGES])
  range: OverviewRange = '24h';
}
