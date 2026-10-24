import type { AlertRule } from '../../generated/prisma/client';

/**
 * 消息里除"当前值"之外、需要额外查一次才知道的上下文。
 *
 * 拿不到（比如指标不是 events/users）时整行不输出 —— 显示 "影响用户 undefined"
 * 比不显示更糟：收到通知的人会以为系统坏了。
 */
export interface AlertExtras {
  /** 窗口内受影响的去重用户数 */
  users: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  /** 窗口内最吵的那条问题，用来拼直达链接；null = 这些事件还没归并**
   *  （Worker 有延迟时会短暂出现）*/
  topGroupId: string | null;
}

/** 指标的中文名。只在通知文案里用，接口返回的仍是英文枚举 */
const METRIC_LABELS: Record<string, string> = {
  events: '错误数',
  users: '影响用户数',
  new_issues: '新增问题数',
  error_rate: '错误率',
  lcp_p75: 'LCP P75',
};

/**
 * 第二行的"发生了什么"，每个指标一句话。
 *
 * 用映射而不是一串 if：加指标时只加一行，不会漏掉某个分支导致文案变成
 * "最近 5 分钟 undefined"。
 */
function valuePhrase(metric: string, value: number): string {
  switch (metric) {
    case 'events':
      return `发生 ${Math.round(value)} 次`;
    case 'users':
      return `影响 ${Math.round(value)} 个用户`;
    case 'new_issues':
      return `新增 ${Math.round(value)} 个问题`;
    case 'error_rate':
      return `错误率 ${(value * 100).toFixed(2)}%`;
    case 'lcp_p75':
      return `LCP P75 ${Math.round(value)} ms`;
    default:
      return String(value);
  }
}

/** 阈值的写法必须和当前值同一量纲，否则 "> 0.05" 和 "5%" 摆在一起没人看得懂 */
function thresholdText(metric: string, threshold: number): string {
  if (metric === 'error_rate') return `${Number((threshold * 100).toFixed(2))}%`;
  if (metric === 'lcp_p75') return `${threshold} ms`;
  return String(threshold);
}

/**
 * 消息里统一用 UTC 并标注。
 *
 * 服务端容器默认 UTC、开发者机器多半是 UTC+8 —— 不标注时区的话，
 * "首次 10:15" 在两个脑子里是两个时刻，排查时会对不上号。
 */
function formatTime(date: Date): string {
  return date.toISOString().slice(5, 19).replace('T', ' ');
}

/**
 * 直达链接。
 *
 * ── 为什么要带 groupId ──────────────────────────────────────────────────
 * 只给到项目首页等于没链：收到告警的人还得自己在几百条问题里找刚才那个。
 * 带着 groupId 点进去就是那条问题的详情页，这是"直达"的全部意义。
 *
 * ── 为什么可能退化成列表 ────────────────────────────────────────────────
 * 规则目前是**项目级**的（没有绑定某个问题）。如果窗口内的事件还没归并
 * （Worker 有延迟），就拿不到问题 id，只能退到问题列表。
 * 这比拼一个错误的 id 好 —— 那会把用户带到"问题不存在"。
 */
export function buildLink(baseUrl: string, projectId: string, groupId: string | null): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = groupId === null ? '/issues' : `/issues/${groupId}`;
  return `${base}/projects/${projectId}${suffix}`;
}

/**
 * 通知文案（FR-7.6）。
 *
 * 四行，回答四个问题：哪个项目/什么规则、多严重、影响了谁、去哪看。
 * 告警是凌晨三点把人叫醒的东西，多余的信息只会让人更想静音它。
 */
export function buildMessage(input: {
  rule: AlertRule;
  value: number;
  projectName: string;
  link: string;
  extras: AlertExtras | null;
}): string {
  const { rule, value, projectName, link, extras } = input;
  const symbol = rule.comparator === 'lt' ? '<' : '>';
  const label = METRIC_LABELS[rule.metric] ?? rule.metric;

  const lines = [
    `🔴 [${projectName}] ${label}告警`,
    `最近 ${rule.windowMinutes} 分钟${valuePhrase(rule.metric, value)}` +
      `（阈值 ${symbol} ${thresholdText(rule.metric, rule.threshold)}）`,
  ];

  if (extras !== null && extras.firstSeen !== null && extras.lastSeen !== null) {
    lines.push(
      `影响用户 ${extras.users} · 首次 ${formatTime(extras.firstSeen)}` +
        ` · 最近 ${formatTime(extras.lastSeen)}（UTC）`,
    );
  }

  lines.push(`查看：${link}`);
  return lines.join('\n');
}
