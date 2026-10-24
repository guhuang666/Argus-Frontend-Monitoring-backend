import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AlertRule } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertDeliveryService } from './alert-delivery.service';
import { buildLink, buildMessage, type AlertExtras } from './alert-message';
import { EvaluatorLock } from './evaluator-lock';

/** 生产节奏：60 秒一轮（FR-7.8 要求评估周期不超过 1 分钟） */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * 首轮延迟：让 worker 的 "PostgreSQL ready / 队列已就绪" 那几行先打出来，
 * 评估日志接在后面读起来才是一条时间线，而不是混在启动信息里。
 */
const BOOT_DELAY_MS = 3_000;

/** 一轮评估的统计，给日志和测试用 */
export interface EvaluationSummary {
  /** 本轮参与的启用规则数 */
  rules: number;
  /** 越过阈值的规则数（含被静默挡掉的） */
  triggered: number;
  delivered: number;
  failed: number;
  silenced: number;
  /** 窗口内没有样本（例如没有会话、没有 LCP 数据），无法判定 */
  noData: number;
}

/**
 * 告警评估器（M6-3）—— 整条告警链路里唯一会主动做事的地方。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────
 * 每 60 秒醒一次：抢锁 → 拉所有启用的规则 → 按各自的窗口算一遍当前值 →
 * 超过阈值就推送 → 推送成功才打开静默窗口 → 写一条触发历史。
 *
 * ── 为什么必须定期评估，而不是"上报时顺手判断" ────────────────────────
 * 规则的条件是**窗口内的聚合**（"5 分钟内超过 10 次"），单条事件回答不了。
 * 只有当有人回头把一段时间的数据加起来，阈值才有意义。
 *
 * ── 两条必须遵守的纪律 ──────────────────────────────────────────────────
 * ① 窗口是 `[now - window, now)` 半开区间，且**一轮里所有查询共用同一个 now**。
 *    没有右边界、或者每条查询各自取一次 now，边界上的数据会在相邻两轮里
 *    被重复计入，数字系统性偏高，而且不报任何错。
 * ② **推送成功才更新 lastFiredAt**。如果先更新、再推送（而推送失败），
 *    接下来的静默期会替用户"确认"一条他根本没收到的通知 —— 这是告警系统
 *    最伤信任的一种失败：系统看起来一切正常，人却什么都没有收到。
 *
 * ── 为什么跑在 worker 进程 ──────────────────────────────────────────────
 * API 进程会水平扩容，每个副本都起一个评估器 = 一次超标发 N 条。
 * 这里再加一层 Redis 锁（EvaluatorLock），即使 worker 也扩了，同一时刻也只有一个在评估。
 */
@Injectable()
export class AlertEvaluatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertEvaluatorService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private intervalMs = DEFAULT_INTERVAL_MS;

  /** 已经提醒过"这个指标不支持某个过滤条件"的规则 id，避免每分钟刷一遍日志 */
  private readonly warnedIgnores = new Set<string>();

  /** projectId → 项目名。通知里要显示名字，而它几乎不变，缓存到进程重启为止 */
  private readonly projectNames = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: AlertDeliveryService,
    private readonly lock: EvaluatorLock,
  ) {}

  onModuleInit(): void {
    const raw = Number(process.env.ALERT_EVALUATOR_INTERVAL_MS);
    this.intervalMs = Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_INTERVAL_MS;

    this.logger.log(
      `告警评估器已启动：每 ${this.intervalMs / 1000}s 评估一轮，首轮在 ${BOOT_DELAY_MS / 1000}s 后`,
    );

    this.timer = setTimeout(() => {
      void this.runCycle();
    }, BOOT_DELAY_MS);
    // unref：定时器本身不应该阻止进程退出（真正撑着 worker 的是 BullMQ 的消费者）
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 跑一轮（抢锁 + 评估 + 释放）。
   *
   * 公开是为了让测试和"手动触发一次"的脚本能直接调用 —— 但生产代码里
   * 只有定时器会调它。**不要**在控制器里暴露这个入口：那等于给外部一个
   * 能反复触发告警的按钮。
   */
  async tick(): Promise<void> {
    let token: string | null;
    try {
      token = await this.lock.tryAcquire();
    } catch (err) {
      // Redis 不可用时不评估：宁可晚一轮，也不要多个实例同时发消息
      this.logger.warn(`抢评估锁失败，本轮跳过：${String(err)}`);
      return;
    }

    if (token === null) {
      this.logger.debug('上一轮评估尚未结束（锁被占用），本轮跳过');
      return;
    }

    try {
      const summary = await this.evaluateOnce();
      if (summary.triggered > 0) {
        this.logger.log(
          `评估完成：${summary.rules} 条规则 · 触发 ${summary.triggered}` +
            ` · 投递成功 ${summary.delivered} · 失败 ${summary.failed}` +
            ` · 静默 ${summary.silenced} · 无样本 ${summary.noData}`,
        );
      }
    } catch (err) {
      this.logger.error(`评估失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      await this.lock.release(token).catch((err: unknown) => {
        this.logger.warn(`释放评估锁失败（会在 ${this.intervalMs / 1000}s 后自然过期）：${String(err)}`);
      });
    }
  }

  /**
   * 单轮评估。
   *
   * `now` 参数化是为了测试能钉死时间（"窗口里到底算了哪几秒"必须可断言）；
   * 生产调用不传，取当前时刻。
   */
  async evaluateOnce(now: Date = new Date()): Promise<EvaluationSummary> {
    // 一次查完所有启用规则。逐条查会变成 N+1：规则 20 条就是 20 次往返，
    // 而评估是每分钟都要跑一次的
    const rules = await this.prisma.alertRule.findMany({ where: { enabled: true } });

    const summary: EvaluationSummary = {
      rules: rules.length,
      triggered: 0,
      delivered: 0,
      failed: 0,
      silenced: 0,
      noData: 0,
    };

    for (const rule of rules) {
      const from = new Date(now.getTime() - rule.windowMinutes * 60_000);

      const value = await this.computeValue(rule, from, now);
      if (value === null) {
        // 没有样本 ≠ 值是 0。lt 规则（"低于阈值告警"）在无数据时绝不能触发，
        // 否则一个没有流量的项目会每 60 秒报一次"错误率低于阈值"
        summary.noData += 1;
        continue;
      }

      if (!isTriggered(rule.comparator, value, rule.threshold)) {
        continue;
      }
      summary.triggered += 1;

      if (isSilenced(rule, now)) {
        summary.silenced += 1;
        continue;
      }

      // 走到这里才去查"项目叫什么、影响了谁、该链到哪"——
      // 这些是**通知内容**，只有真要发的时候才需要，不该让每一轮评估都为
      // 没触发的规则付查询成本
      const projectName = await this.projectName(rule.projectId);
      const extras = await this.loadExtras(rule, from, now);
      const text = buildMessage({
        rule,
        value,
        projectName,
        link: buildLink(this.dashboardUrl(), rule.projectId, extras?.topGroupId ?? null),
        extras,
      });

      const result = await this.delivery.deliver(rule, text);

      if (result.ok) {
        // 条件更新：只有"还是那句话没说过"时才打开静默。
        // 与内存里的判断重复，是因为内存判断发生在好几秒之前（投递可能很慢），
        // 这中间另一个评估器理论上可能已经把闸门关了
        const cutoff = new Date(now.getTime() - rule.silenceMinutes * 60_000);
        const { count } = await this.prisma.alertRule.updateMany({
          where: {
            id: rule.id,
            projectId: rule.projectId,
            OR: [{ lastFiredAt: null }, { lastFiredAt: { lte: cutoff } }],
          },
          data: { lastFiredAt: now },
        });
        if (count === 0) {
          this.logger.warn(`规则 ${rule.id} 的静默闸门已被占先，本次通知可能是重复的`);
        }
        summary.delivered += 1;
      } else {
        // 投递失败**不**更新 lastFiredAt：下一轮会重试，用户仍然有机会收到。
        // 但历史要留一条 delivered=false —— 否则"为什么我没收到"永远查不出来
        summary.failed += 1;
      }

      await this.prisma.alertEvent.create({
        data: {
          ruleId: rule.id,
          projectId: rule.projectId,
          firedAt: now,
          value,
          // 触发时的规则快照：规则可以被编辑，历史必须能自己解释自己
          metric: rule.metric,
          threshold: rule.threshold,
          windowMinutes: rule.windowMinutes,
          delivered: result.ok,
          error: result.ok ? null : (result.error ?? '投递失败（未返回原因）'),
        },
      });
    }

    return summary;
  }

  /** 按指标取当前值。返回 null 表示"窗口内没有样本，无从判定" */
  private async computeValue(rule: AlertRule, from: Date, to: Date): Promise<number | null> {
    switch (rule.metric) {
      case 'events':
        return this.countEvents(rule, from, to);
      case 'users':
        return this.countUsers(rule, from, to);
      case 'new_issues':
        return this.countNewIssues(rule, from, to);
      case 'error_rate':
        return this.errorRate(rule, from, to);
      case 'lcp_p75':
        return this.lcpP75(rule, from, to);
      default:
        this.logger.warn(`规则 ${rule.id} 的 metric 不认识：${rule.metric}，跳过`);
        return null;
    }
  }

  /**
   * 窗口内的事件条数（events）。
   *
   * 读 `error_events` 明细而不是 `issue_stats_hourly`：后者是小时粒度，
   * 5 分钟的窗口在它上面只能取到"整整一小时"，判出来的东西完全不是规则想要的。
   * 代价是每分钟扫一次明细，靠 `(project_id, timestamp)` 索引兜住。
   *
   * 环境/版本过滤用"参数为空则不筛"的写法，避免为四种组合写四条 SQL：
   * `($2::text IS NULL OR environment = $2)`。
   */
  private async countEvents(rule: AlertRule, from: Date, to: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM error_events
       WHERE project_id = ${rule.projectId}::uuid
         AND timestamp >= ${from}
         AND timestamp <  ${to}
         AND (${rule.environment}::text IS NULL OR environment = ${rule.environment}::text)
         AND (${rule.release}::text IS NULL OR release = ${rule.release}::text)
    `;
    return rows[0]?.n ?? 0;
  }

  /** 窗口内的影响用户数（去重；没有 user_id 的事件不计） */
  private async countUsers(rule: AlertRule, from: Date, to: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(DISTINCT user_id)::int AS n
        FROM error_events
       WHERE project_id = ${rule.projectId}::uuid
         AND timestamp >= ${from}
         AND timestamp <  ${to}
         AND user_id IS NOT NULL
         AND (${rule.environment}::text IS NULL OR environment = ${rule.environment}::text)
         AND (${rule.release}::text IS NULL OR release = ${rule.release}::text)
    `;
    return rows[0]?.n ?? 0;
  }

  /**
   * 窗口内新增的问题数（new_issues）。
   *
   * ⚠️ `error_groups` 上没有 environment 列，release 也只有 first/last 两个版本列，
   * 所以这条规则**无法**按环境/版本过滤。配了过滤条件时给一次提醒，
   * 而不是安静地按全量算 —— 后者会让"只看生产环境"变成一个假的承诺。
   */
  private async countNewIssues(rule: AlertRule, from: Date, to: Date): Promise<number> {
    this.warnIgnoredFilters(rule, 'new_issues');
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM error_groups
       WHERE project_id = ${rule.projectId}::uuid
         AND first_seen >= ${from}
         AND first_seen <  ${to}
    `;
    return rows[0]?.n ?? 0;
  }

  /**
   * 窗口内的错误率 = 出过错的会话 / 总会话。
   *
   * 分母为 0 时返回 null（"没有访问数据"），不是 0。
   * 这两者绝不能混：把"没人来"算成"0% 错误率、一切正常"，
   * 是一个监控平台能犯的最误导人的错误。
   */
  private async errorRate(rule: AlertRule, from: Date, to: Date): Promise<number | null> {
    this.warnIgnoredFilters(rule, 'error_rate');
    const rows = await this.prisma.$queryRaw<Array<{ total: number; errored: number }>>`
      SELECT COUNT(*)::int                                AS total,
             COUNT(*) FILTER (WHERE had_error)::int       AS errored
        FROM sessions
       WHERE project_id = ${rule.projectId}::uuid
         AND started_at >= ${from}
         AND started_at <  ${to}
    `;
    const row = rows[0];
    if (row === undefined || row.total === 0) return null;
    return row.errored / row.total;
  }

  /** 窗口内 LCP 的 P75。没有样本时 percentile_cont 返回 NULL，正是我们要的"无从判定" */
  private async lcpP75(rule: AlertRule, from: Date, to: Date): Promise<number | null> {
    this.warnIgnoredFilters(rule, 'lcp_p75');
    const rows = await this.prisma.$queryRaw<Array<{ p75: number | null }>>`
      SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY lcp) AS p75
        FROM performance_metrics
       WHERE project_id = ${rule.projectId}::uuid
         AND timestamp >= ${from}
         AND timestamp <  ${to}
         AND lcp IS NOT NULL
    `;
    return rows[0]?.p75 ?? null;
  }

  /** 看板基址。容器里的进程没有浏览器，链接必须是绝对地址才点得开 */
  private dashboardUrl(): string {
    return process.env.DASHBOARD_URL ?? 'http://localhost:5173';
  }

  /**
   * 项目名（带缓存）。
   *
   * 一个项目可能挂 10 条规则，每条触发都查一次 projects 表纯属浪费。
   * 缓存在进程内存里，代价是改名后通知里会显示旧名字 —— 不影响任何判定，
   * 也就不值得为它引入失效通知。
   */
  private async projectName(projectId: string): Promise<string> {
    const cached = this.projectNames.get(projectId);
    if (cached !== undefined) return cached;

    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });
    // 项目已被删、规则还没级联删完（并发窗口）：用 id 前缀兜底，
    // 总比在通知里显示 "undefined" 强
    const name = row?.name ?? projectId.slice(0, 8);
    this.projectNames.set(projectId, name);
    return name;
  }

  /**
   * "影响了谁、什么时候"的最后一行。
   *
   * 只有 events / users 两个指标查得到 —— 它们的窗口值本来就建立在
   * `error_events` 上。其余指标没有"发生时刻"这回事，返回 null，
   * 消息里就少一行。**不编造**是这里的原则。
   *
   * 两个查询并行：它们是同一份过滤条件的两个视角，串行只会白等一次 RTT。
   */
  private async loadExtras(rule: AlertRule, from: Date, to: Date): Promise<AlertExtras | null> {
    if (rule.metric !== 'events' && rule.metric !== 'users') return null;

    const [statsRows, topRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ users: number; first_seen: Date | null; last_seen: Date | null }>
      >`
        SELECT COUNT(DISTINCT user_id)::int AS users,
               MIN(timestamp)               AS first_seen,
               MAX(timestamp)               AS last_seen
          FROM error_events
         WHERE project_id = ${rule.projectId}::uuid
           AND timestamp >= ${from}
           AND timestamp <  ${to}
           AND (${rule.environment}::text IS NULL OR environment = ${rule.environment}::text)
           AND (${rule.release}::text IS NULL OR release = ${rule.release}::text)
      `,
      this.prisma.$queryRaw<Array<{ group_id: string }>>`
        SELECT group_id
          FROM error_events
         WHERE project_id = ${rule.projectId}::uuid
           AND timestamp >= ${from}
           AND timestamp <  ${to}
           AND group_id IS NOT NULL
           AND (${rule.environment}::text IS NULL OR environment = ${rule.environment}::text)
           AND (${rule.release}::text IS NULL OR release = ${rule.release}::text)
         GROUP BY group_id
         ORDER BY COUNT(*) DESC
         LIMIT 1
      `,
    ]);

    const stats = statsRows[0];
    return {
      users: stats?.users ?? 0,
      firstSeen: stats?.first_seen ?? null,
      lastSeen: stats?.last_seen ?? null,
      // Worker 还没归并完时这里会是 null，消息里就退化成问题列表链接
      topGroupId: topRows[0]?.group_id ?? null,
    };
  }

  /**
   * 这些指标的数据表上没有 environment / release 列，过滤条件会被忽略。
   * 只提醒一次，避免每分钟刷日志；但必须提醒 —— 静默忽略等于骗人。
   */
  private warnIgnoredFilters(rule: AlertRule, metric: string): void {
    if (rule.environment === null && rule.release === null) return;
    if (this.warnedIgnores.has(rule.id)) return;
    this.warnedIgnores.add(rule.id);
    this.logger.warn(
      `规则 ${rule.id}（${metric}）配置了 environment/release 过滤，但该指标的数据源没有这两列，` +
        `本次及以后都会按全量统计`,
    );
  }

  /** 下一轮。用 setTimeout 而不是 setInterval：上一轮慢的时候不会堆积重叠的轮次 */
  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runCycle();
    }, this.intervalMs);
    this.timer.unref();
  }

  private async runCycle(): Promise<void> {
    try {
      await this.tick();
    } finally {
      this.scheduleNext();
    }
  }
}

/* ───────────────────────── 纯函数（单测直接覆盖）───────────────────────── */

/**
 * 阈值比较。
 *
 * `gt` / `lt` 都取**严格**不等：规则写 "> 10" 时，正好 10 次不该响。
 * 把边界算成触发，会让"刚好压线"的日常流量制造一堆没有价值的通知。
 */
export function isTriggered(comparator: string, value: number, threshold: number): boolean {
  return comparator === 'lt' ? value < threshold : value > threshold;
}

/** 静默判定：距离上次**成功通知**不到 silenceMinutes 就算静默期内 */
export function isSilenced(rule: Pick<AlertRule, 'lastFiredAt' | 'silenceMinutes'>, now: Date): boolean {
  if (rule.lastFiredAt === null) return false;
  const cutoff = now.getTime() - rule.silenceMinutes * 60_000;
  return rule.lastFiredAt.getTime() > cutoff;
}
