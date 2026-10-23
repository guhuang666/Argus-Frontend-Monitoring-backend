import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RANGE_MS, type OverviewRange } from './dto/overview-query.dto';
import { PERF_METRICS, type PerfMetric } from './dto/performance-query.dto';

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
    const { bucket, from, to } = this.window(range);

    // 三条查询放进同一个事务：同一快照下读，避免"总量比趋势之和还小"
    // 这种自相矛盾的页面上限（并发写入时确实会发生）
    const [summaryRows, newIssueRows, trendRows] =
      await this.prisma.$transaction([
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
    const points = this.fillGaps(trendRows, from, to, bucket.ms, (t, row) => ({
      t,
      // 缺失的桶补 0：趋势图的 y 轴是"有没有事"，0 是正确语义
      events: row === undefined ? 0 : toNumber(row.events),
    }));

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
   * 性能指标的分位趋势（M5 / FR-2）。
   *
   * GET /api/v1/stats/performance?projectId=&metric=lcp&range=24h
   *
   * ── 为什么是"每桶各自算分位数"，而不是给整个窗口算一个 ──────────────────
   * 分位数**不可加**：09 点的 P95 是 800ms、10 点是 1200ms，两小时合起来的 P95
   * 既不是 1000 也不是平均值。真要"合并"必须保留分布本身（t-digest / HDR 直方图），
   * 那是另一个量级的工作。所以这里每个桶独立 `percentile_cont`，图上画的是
   * "每个小时的 P95"——趋势看的是**曲线在动**，不是"这个窗口的精确 P95"。
   * 需要"整个窗口一个 P95"时，那是另一条不 GROUP BY 的 SQL，
   * **别指望把这 24 个点加起来或平均出来**。
   *
   * ── 三个坑（都会静默出错，一个异常都不抛）──────────────────────────
   * ① `WHERE <列> IS NOT NULL` —— null 不是 0。混进去 `percentile_cont` 会把整桶
   *    的分位数往 0 拉：用户没交互时 INP 天然为空，一来就把"真实 300ms"算成
   *    "看起来 120ms"。这行 WHERE 是本方法正确性的一半。
   * ② 空桶必须补齐（见 fillGaps）—— SQL 只返回有样本的桶。不补的话 x 轴被压缩，
   *    "连续 6 小时没人用"和"每分钟都在采样"在图上长得一模一样。
   * ③ 缺桶的 p50/p75/p95 必须是 **null**，不能是 0。0ms 的 LCP 是完美成绩，
   *    拿它当"没有数据"会画出一条假的"性能极好"直线。前端据此断开折线。
   *
   * ── 为什么这里读明细，而概览读聚合表（TC-12 的例外）──────────────────
   * TC-12 要求趋势类查询读预聚合表，但**性能数据目前没有预聚合表**：
   * 分位数不能像 event_count 那样先求和（见上），预聚合得另存每桶的
   * p50/p75/p95，还要配套一张表 + 回填 + 对账。本阶段数据量小，
   * 先直接读 `performance_metrics`，走 (project_id, timestamp) 索引。
   * 等 M7 压测真的撞墙（1000 万事件 P95 ≤ 500ms）再补 `perf_stats_hourly`——
   * 那时手上有真实慢查询，建表才有依据；现在建只是猜。
   */
  async performanceTrend(
    projectId: string,
    metric: PerfMetric,
    range: OverviewRange,
  ) {
    const { bucket, from, to } = this.window(range);

    /**
     * metric → 列名。**这里是唯一的安全边界。**
     *
     * SQL 里的表名/列名不能参数化（`$1` 只能绑"值"，绑不了标识符），
     * 所以列名只能拼进语句文本。拼之前必须确认它来自代码里的常量，
     * 而不是来自请求字符串 —— 否则就是教科书式的 SQL 注入。
     * DTO 的 @IsIn 是第一道闸（给调用方一个干净的 400），
     * 这第二道保证"将来有人绕过 DTO 开新入口"时依然安全。
     */
    const columnName = (
      PERF_METRIC_COLUMN as Record<string, string | undefined>
    )[metric];
    if (columnName === undefined) {
      throw new BadRequestException(
        `不支持的性能指标: ${String(metric)}（可选：${PERF_METRICS.join(' / ')}）`,
      );
    }
    const column = Prisma.raw(columnName);

    /**
     * `date_bin` 与概览用的是同一个 origin（2000-01-01T00:00:00Z），
     * 所以本查询的桶边界和 fillGaps 的 `floor(epoch / ms) * ms` 逐位相等。
     *
     * 为什么用 date_bin 而不是 date_trunc：`date_trunc('hour', timestamptz)`
     * 按**会话时区**截断，换个 TimeZone 结果就变；`date_bin` 按从 origin 起的
     * 绝对时长切分，与时区无关。二者对 1 小时步长恰好常常给出相同结果，
     * 所以这个 bug 只在"换台机器/换个连接参数字典"时才冒出来 —— 最难查的那种。
     *
     * `"timestamp"` 必须加引号：它是保留字，裸写会被当成类型名解析。
     */
    const rows = await this.prisma.$queryRaw<PerfTrendRow[]>`
      SELECT date_bin(${bucket.interval}::interval, "timestamp", TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${column}) AS p50,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY ${column}) AS p75,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ${column}) AS p95,
             COUNT(${column}) AS samples
        FROM performance_metrics
       WHERE project_id = ${projectId}::uuid
         AND "timestamp" >= ${from}
         AND "timestamp" <  ${to}
         AND ${column} IS NOT NULL
       GROUP BY 1
       ORDER BY 1
    `;

    const points = this.fillGaps(rows, from, to, bucket.ms, (t, row) => ({
      t,
      // 缺桶 / 整桶都没样本 → null。这里**绝不能**用 toNumber()：它会把 null 变成 0
      p50: toNullableNumber(row?.p50),
      p75: toNullableNumber(row?.p75),
      p95: toNullableNumber(row?.p95),
      samples: row === undefined ? 0 : toNumber(row.samples),
    }));

    return {
      metric,
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      /** 每个点代表多长时间。前端拿它决定 x 轴标签的格式 */
      bucket: bucket.unit,
      trend: points,
    };
  }

  /**
   * 时间窗口：**最近 N 个整桶**，N = range / 桶长（24 / 168 / 30）。
   *
   * ── 为什么不是"从此刻往前推 24 × 3600 秒" ────────────────────────────────
   * 那样算出来的窗口起点不是整点，趋势图会有两个后果：
   *   · **点数会在 24 / 25 之间跳**：now=06:30 时首桶是昨天 06:00（早于起点，
   *     被 SQL 的 `>= from` 削掉一半）；now=07:00 时又变回 24 个点。
   *     前端每隔一小时刷新一次就发现图"多了一格"，很难解释。
   *   · **首桶是残缺的**：它只统计了 06:30 之后的数据，却画在 06:00 的位置上，
   *     视觉上像是"那个小时特别平静"——和"没人用"完全分不清。
   *
   * 所以窗口对齐到整桶：to 就是此刻，from 是 (count-1) 个桶之前那个整点。
   * 代价是实际跨度比 range 少最多一个桶（24h 实际 23~24 小时），
   * 换来的是点数恒定、每个桶都完整（除了正在进行中的最后一个）。
   * 响应里同时返回 from/to，前端要显示"覆盖范围"时以它为准。
   *
   * 概览与性能趋势**共用**这个函数：两个页面的同一档 range 必须给出同一组
   * x 轴，否则用户切页面会觉得"数据对不上"。
   */
  private window(range: OverviewRange): {
    bucket: (typeof BUCKET_OF)[OverviewRange];
    from: Date;
    to: Date;
  } {
    const bucket = BUCKET_OF[range];
    const to = new Date();
    // 最后一个桶 = 包含"此刻"的那个桶的起点
    const lastBucket = Math.floor(to.getTime() / bucket.ms) * bucket.ms;
    // count 一定是整数：3 档 range 都能被对应的桶长整除（见 BUCKET_OF）
    const count = RANGE_MS[range] / bucket.ms;
    return { bucket, from: new Date(lastBucket - (count - 1) * bucket.ms), to };
  }

  /**
   * 把稀疏的桶补成等距序列。
   *
   * 为什么要补：SQL 只返回"有数据的小时"，没有数据的小时根本不出现。
   * 直接把它们扔给图表，x 轴会被压成等距——凌晨三点没人用、空了 6 小时，
   * 图上看起来和"每分钟都在报错"一样密。补零之后折线才是真正的"有没有事"。
   *
   * 对齐方式必须与 `date_bin` 的 origin 一致：
   * origin 是 2000-01-01T00:00:00Z，对 1 小时 / 1 天这两种步长来说，
   * 它同时是 epoch 的整数倍，所以这里用 `floor(epoch / ms) * ms` 与之逐位相等。
   * 以后若要加 6 小时这类步长，需要回来核对这条等价关系。
   *
   * ── 为什么 `toPoint` 是参数，而不是让两个调用方各自补空数组 ──────────────
   * 概览的趋势点长这样 `{ t, events }`，性能的趋势点长这样
   * `{ t, p50, p75, p95, samples }`，但"从哪开始、到哪结束、每格多宽"是同一套算术。
   * 把算术留在这里、把"缺的那个桶长什么样"交给调用方，**缺失桶的语义**就由各自
   * 定义：事件数缺桶 = 0（真的没发生），分位数缺桶 = null（没有样本，不等于 0）。
   * 这正是这两个接口最容易写混的地方，所以刻意让它必须在调用点显式写出来。
   */
  private fillGaps<R extends { bucket: Date }, P>(
    rows: R[],
    from: Date,
    to: Date,
    bucketMs: number,
    toPoint: (t: string, row: R | undefined) => P,
  ): P[] {
    const byBucket = new Map<number, R>();
    for (const row of rows) {
      byBucket.set(new Date(row.bucket).getTime(), row);
    }

    const points: P[] = [];
    const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
    for (let ts = start; ts < to.getTime(); ts += bucketMs) {
      points.push(toPoint(new Date(ts).toISOString(), byBucket.get(ts)));
    }
    return points;
  }
}

/** 与 overview-query.dto 的 range 一一对应；type 上不收 1h，这里也就不给 */
const BUCKET_OF: Record<
  OverviewRange,
  { interval: '1 hour' | '1 day'; ms: number; unit: 'hour' | 'day' }
> = {
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

/**
 * metric → SQL 列名。
 *
 * 目前三个 key 和列名同名（lcp/cls/inp），看着像多余的一层映射，
 * 但它存在的意义是两个：
 *   ① **白名单**：只有出现在这里的字符串才允许被拼进 SQL（见 performanceTrend）
 *   ② **隔离改名**：将来列名改成 `lcp_ms`，只需要改这里，接口契约不用动
 */
const PERF_METRIC_COLUMN: Record<PerfMetric, string> = {
  lcp: 'lcp',
  cls: 'cls',
  inp: 'inp',
};

/**
 * 分位趋势的原始行。
 *
 * p50/p75/p95 的类型是 `number | null` 而不是 `number`：空窗口时
 * `percentile_cont` 在没有行的分组上根本不存在（连 NULL 都不会返回，是没这行），
 * 但一旦某桶里全是 NULL 值、又被 WHERE 过滤干净，也可能出现 NULL ——
 * 两种都要能表达成"这个点没数据"。
 */
interface PerfTrendRow {
  bucket: Date;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  samples: bigint | number;
}

function toNumber(value: bigint | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * 与 `toNumber` 的唯一区别：**null 保持 null**。
 *
 * 分位数的 null 是"这一桶没有样本"，0 是"样本的延迟就是 0ms"——
 * 在前端一个画成断线、一个画成贴地直线，混起来就是一张骗人的图。
 * 这两个函数名字像、行为差一个 0，所以刻意放在一起并写清区别。
 */
function toNullableNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}
