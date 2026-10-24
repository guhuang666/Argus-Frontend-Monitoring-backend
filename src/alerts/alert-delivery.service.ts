import { Injectable, Logger } from '@nestjs/common';
import type { AlertRule } from '../../generated/prisma/client';

/** 投递结果。`error` 只在失败时有值，且会被截断到 500 字符（列宽） */
export interface DeliveryResult {
  ok: boolean;
  error?: string;
  /** 一共尝试了几次（1 = 一次成功；4 = 首试 + 3 次重试全失败） */
  attempts: number;
}

/** 单次请求超时。告警是"尽快通知"，卡住 30 秒的通知等于没发出去 */
const TIMEOUT_MS = 5_000;

/** alert_events.error 是 VarChar(500)，超了会 P2000 → 500，所以截断在写库前做 */
const ERROR_MAX = 500;

/**
 * 重试间隔：1s → 2s → 4s，合计最多等 7 秒。
 *
 * 只处理"抖一下就好"的故障（webhook 服务重启、网络瞬断）。
 * 更长时间的故障不靠这里扛 —— 投递失败不会更新 lastFiredAt，
 * 下一轮评估（60 秒后）会带着新的数值再试一次，这才是兜底的那层。
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/** 单次尝试的结论。`retryable` 决定要不要再来一次 */
interface AttemptResult {
  ok: boolean;
  error?: string;
  retryable: boolean;
}

/**
 * 告警投递器（M6-4）。
 *
 * ── 三家 payload 的差别 ──────────────────────────────────────────────────
 * 飞书自定义机器人：`{ msg_type: "text", content: { text } }`
 * 钉钉自定义机器人：`{ msgtype: "text", text: { content } }`
 * Slack incoming webhook：`{ text }`
 *
 * ── 为什么 HTTP 200 也可能是失败 ────────────────────────────────────────
 * 飞书/钉钉在 token 失效、关键词不匹配、频率超限时**仍然返回 200**，
 * 真正的结果在响应体的 code / errcode 里。只看 HTTP 状态码会把"没发出去"
 * 记成"已通知"，而这正是告警系统最不能出的错。
 *
 * ── 哪些错误值得重试 ────────────────────────────────────────────────────
 *   超时 / 网络错误     → 重试（对方可能只是重启了一下）
 *   HTTP 5xx            → 重试（对端临时故障）
 *   HTTP 4xx            → **不重试**（地址错了、token 失效，重试一百次也一样）
 *   业务 errcode ≠ 0    → **不重试**（配置问题，同上）
 * 把不可重试的错误也重试，只会让"到达延迟"变成"到达延迟 + 7 秒"，还刷日志。
 */
@Injectable()
export class AlertDeliveryService {
  private readonly logger = new Logger(AlertDeliveryService.name);

  async deliver(rule: AlertRule, text: string): Promise<DeliveryResult> {
    const body = buildPayload(rule.channel, text);

    let last: AttemptResult = { ok: false, error: '未发出请求', retryable: false };
    const maxAttempts = RETRY_DELAYS_MS.length + 1;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      last = await this.sendOnce(rule, body);

      if (last.ok) {
        if (attempt > 1) {
          this.logger.log(`规则 ${rule.id} 第 ${attempt} 次尝试投递成功`);
        }
        return { ok: true, attempts: attempt };
      }

      const delay = RETRY_DELAYS_MS[attempt - 1];
      if (!last.retryable || delay === undefined) {
        break;
      }

      this.logger.warn(
        `规则 ${rule.id} 第 ${attempt} 次投递失败（${last.error ?? '未知原因'}），${delay}ms 后重试`,
      );
      await sleep(delay);
    }

    return {
      ok: false,
      error: last.error ?? '投递失败（未返回原因）',
      attempts,
    };
  }

  /**
   * 发一次。不抛异常 —— 所有失败都变成 `{ ok: false, retryable }`，
   * 让重试循环只有一个出口，也方便单测直接断言"该不该重试"。
   */
  private async sendOnce(rule: AlertRule, body: Record<string, unknown>): Promise<AttemptResult> {
    try {
      const res = await fetch(rule.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const raw = await res.text();

      if (!res.ok) {
        return {
          ok: false,
          error: truncate(`HTTP ${res.status}: ${raw}`),
          // 5xx 是对端临时故障；4xx 是我们自己的配置问题
          retryable: res.status >= 500,
        };
      }

      const bizError = readBizError(raw);
      if (bizError !== null) {
        return { ok: false, error: truncate(bizError), retryable: false };
      }

      return { ok: true, retryable: false };
    } catch (err) {
      // 网络错误、超时、DNS 失败。规则 id 打出来，不打完整 webhook 地址
      // （那是密钥，日志一旦被导出就等于泄露）
      return {
        ok: false,
        error: truncate(err instanceof Error ? err.message : String(err)),
        retryable: true,
      };
    }
  }
}

/** 按渠道拼请求体。导出给单测用，生产代码只经 deliver() 调用 */
export function buildPayload(channel: string, text: string): Record<string, unknown> {
  if (channel === 'feishu') {
    return { msg_type: 'text', content: { text } };
  }
  if (channel === 'dingtalk') {
    return { msgtype: 'text', text: { content: text } };
  }
  // slack 以及未知渠道都退化成最通用的形状：多给一个渠道不支持时，
  // 至少还能收到一条能读的消息，而不是静默失败
  return { text };
}

/**
 * 从响应体里挖业务错误码。
 *
 * 飞书：`{ code: 19021, msg: "sign match fail" }`
 * 钉钉：`{ errcode: 310000, errmsg: "..." }`
 * 正常返回是 `{ code: 0 }` / `{ errcode: 0 }`，或者根本没有这两个字段。
 */
export function readBizError(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 不是 JSON（比如 Slack 的 "ok"）：没有业务错误码可查，按成功处理
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const body = parsed as { code?: unknown; errcode?: unknown; msg?: unknown; errmsg?: unknown };

  for (const key of ['code', 'errcode'] as const) {
    const value = body[key];
    if (typeof value === 'number' && value !== 0) {
      const message = typeof body.msg === 'string' ? body.msg : body.errmsg;
      return `${key}=${value}${typeof message === 'string' ? ` ${message}` : ''}`;
    }
  }
  return null;
}

function truncate(text: string, max: number = ERROR_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
