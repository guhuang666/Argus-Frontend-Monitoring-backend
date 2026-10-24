/**
 * 告警规则的取值集合。
 *
 * 与 `schema.prisma` 里 AlertRule 的注释逐字对应，也和前端下拉框共用同一组
 * 中文标签（前端另有一份，因为后端不该为展示层返回文案）。
 *
 * 用 `as const` 数组而不是 TS enum：
 *   · 与项目里其它 DTO（ISSUE_STATUSES / PROJECT_PLATFORMS）保持同一种写法
 *   · `@IsIn([...X])` 需要的是数组，enum 要多一层转换
 */

/** 被监控的指标 */
export const ALERT_METRICS = ['events', 'users', 'new_issues', 'error_rate', 'lcp_p75'] as const;

export type AlertMetric = (typeof ALERT_METRICS)[number];

/** 比较方向：gt = 大于阈值触发，lt = 小于阈值触发 */
export const ALERT_COMPARATORS = ['gt', 'lt'] as const;

export type AlertComparator = (typeof ALERT_COMPARATORS)[number];

/** 投递渠道。三家的 payload 形状不同，由 M6-4 的投递器分派 */
export const ALERT_CHANNELS = ['feishu', 'slack', 'dingtalk'] as const;

export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/**
 * 规则名的长度上限，与 `alert_rules.name` 的 VarChar(100) 对齐。
 * 不在 DTO 里拦的话，超长会在数据库层变成 500（P2000）而不是 400。
 */
export const ALERT_NAME_MAX = 100;

/**
 * 统计窗口的上下限（秒级评估没有意义，本系统的数据最细就是分钟级；
 * 上限 24 小时是因为再长的窗口用"概览页"看更合适，告警只负责"最近出没出事"）。
 */
export const ALERT_WINDOW_MIN = 1;
export const ALERT_WINDOW_MAX = 1440;

/** 静默期上限同上：超过一天还没人处理，问题不在通知频率上 */
export const ALERT_SILENCE_MIN = 0;
export const ALERT_SILENCE_MAX = 1440;
