import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RANGE_MS, type OverviewRange } from './dto/overview-query.dto';

/**
 * 概览页唯一的读接口（GET /api/v1/stats/overview）。
 *
 * ── 为什么整段都是 $queryRaw 而不是 Prisma 的 groupBy ────────────────────
 * 需要按"小时桶"分组（`date_bin`），Prisma 的 groupBy 只支持按列原值分组，
 * 表达不了"把 09:37 归到 09:00"这种截断。凡是趋势类查询都绕不开原生 SQL，
 * 这在本模块是常态而不是例外。
 *
 * ── 数据源纪律（TC-12）──────────────────────────────────────────────────
 * 趋势、总量、问题数三项**全部来自 `issue_stats_hourly`**，一条明细都不扫。
 * 明细只保留 30 天（FR-4.11），而聚合表是永久的——趋势若读明细，
 * 数据一过期曲线就会凭空"变好"，那是比慢更严重的问题。
 * 唯一读 `error_groups` 的是"新问题数"，它没有对应的聚合表，
 * 且过滤条件是 `first_seen` 的时间范围，走 (project_id, first_seen) 能定位。
 *
 * ── 本批刻意不做的事 ───────────────────────────────────────────────────
 *   · Top N 排行：要在窗口内 `SUM(event_count) GROUP BY group_id` 再回表取标题，
 *     属于下一个批次；注意**不能用 error_groups.times_seen**，那是累计值，
 *     拿来排序得到的是"历史总榜"而不是"近 24 小时榜"
 *   · 影响用户数：`issue_stats_hourly.user_count` 是"每小时 × 每组"的首次影响计数，
 *     跨小时、跨组直接求和都会重复计同一个人；精确去重要查 affected_users，
 *     同样留到下一批
 */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 窗口内的概览数据。
   *
   * 窗口定义：`[from, to)`，左闭右开。用半开区间是为了让"连续切两次窗口"
   * 时边界上的那条事件只被算一次——闭区间会让相邻两个窗口都算它。
   * 两个端点都由服务端时钟决定（不用客户端传的时间），避免各端时钟漂移
   * 导致的"同一时刻两个人看到不同总数"。
   */
  async overview(projectId: string, range: OverviewRange) {
    const bucket = BUCKET_OF[range];
    const to = new Date();
    const from = new Date(to.getTime() - RANGE_MS[range]);

    // 三条查询放进同一个事务：同一快照下读，避免"总量比趋势之和还小"
    // 这种自相矛盾的页面上限（并发写入时确实会发生）
    const [summaryRows, newIssueRows, trendRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<SummaryRow[]>`
        SELECT COALESCE(SUM(event_count), 0) AS events,
               COUNT(DISTINCT group_id)      AS issues
          FROM issue_stats_hourly
         WHERE project_id = ${projectId}::uuid
           AND hour >= ${from}
           AND hour <  ${to}
      `,
      this.prisma.$queryRaw<NewIssueRow[]>`
        SELECT COUNT(*) AS n
          FROM error_groups
         WHERE project_id = ${projectId}::uuid
           AND first_seen >= ${from}
           AND first_seen <  ${to}
      `,
      this.prisma.$queryRaw<TrendRow[]>`
        SELECT date_bin(${bucket.interval}::interval, hour, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
               SUM(event_count) AS events
          FROM issue_stats_hourly
         WHERE project_id = ${projectId}::uuid
           AND hour >= ${from}
           AND hour <  ${to}
         GROUP BY 1
         ORDER BY 1
      `,
    ]);

    const summary = summaryRows[0];
    const points = this.fillGaps(trendRows, from, to, bucket.ms);

    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      /** 每个点代表多长时间。前端拿它决定 x 轴标签的格式 */
      bucket: bucket.unit,
      summary: {
        events: toNumber(summary?.events),
        issues: toNumber(summary?.issues),
        new_issues: toNumber(newIssueRows[0]?.n),
      },
      trend: points,
    };
  }

  /**
   * 把稀疏的桶补成等距序列。
   *
   * 为什么要补：SQL 只返回"有数据的小时"，没有事件的小时根本不出现。
   * 直接把它们扔给图表，x 轴会被压成等距——凌晨三点没人用、空了 6 小时，
   * 图上看起来和"每分钟都在报错"一样密。补零之后折线才是真正的"有没有事"。
   *
   * 对齐方式必须与 `date_bin` 的 origin 一致：
   * origin 是 2000-01-01T00:00:00Z，对 1 小时 / 1 天这两种步长来说，
   * 它同时是 epoch 的整数倍，所以这里用 `floor(epoch / ms) * ms` 与之逐位相等。
   * 以后若要加 6 小时这类步长，需要回来核对这条等价关系。
   */
  private fillGaps(
    rows: TrendRow[],
    from: Date,
    to: Date,
    bucketMs: number,
  ): Array<{ t: string; events: number }> {
    const byBucket = new Map<number, number>();
    for (const row of rows) {
      byBucket.set(new Date(row.bucket).getTime(), toNumber(row.events));
    }

    const points: Array<{ t: string; events: number }> = [];
    const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
    for (let ts = start; ts < to.getTime(); ts += bucketMs) {
      points.push({ t: new Date(ts).toISOString(), events: byBucket.get(ts) ?? 0 });
    }
    return points;
  }
}

/** 与 overview-query.dto 的 range 一一对应；type 上不收 1h，这里也就不给 */
const BUCKET_OF: Record<OverviewRange, { interval: '1 hour' | '1 day'; ms: number; unit: 'hour' | 'day' }> = {
  // 24 小时切成 24 个整点：能看出"早上九点那波"这种量级的小时级起伏
  '24h': { interval: '1 hour', ms: 3_600_000, unit: 'hour' },
  // 7 天保持小时粒度（168 个点）：最近一周正是要细看的时候，
  // 折成天桶会把"某天晚上集中爆了一次"抹平
  '7d': { interval: '1 hour', ms: 3_600_000, unit: 'hour' },
  // 30 天切到天桶（30 个点）：再按小时画就是 720 个点挤在 600px 里，
  // 视觉上只会糊成一片，那时更该看趋势的斜率而不是具体小时
  '30d': { interval: '1 day', ms: 86_400_000, unit: 'day' },
};

/**
 * 原始行的类型。SUM/COUNT 在 PG 里是 bigint，Prisma 映射成 BigInt ——
 * 直接塞进 JSON.stringify 会抛 "Do not know how to serialize a BigInt"，
 * 所以出口处必须过一遍 Number()（计数远不可能到 2^53）。
 */
interface SummaryRow {
  events: bigint | number;
  issues: bigint | number;
}

interface NewIssueRow {
  n: bigint | number;
}

interface TrendRow {
  bucket: Date;
  events: bigint | number;
}

function toNumber(value: bigint | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}
