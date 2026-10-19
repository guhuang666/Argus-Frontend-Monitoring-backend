import type { Request } from 'express';

/**
 * 从上报请求里取出公钥。
 *
 * ── 为什么两处都要看，且 header 优先 ────────────────────────────────────
 *   常规通道：SDK 用 fetch，可以自由设请求头 → X-Argus-Key
 *   退场通道：pagehide 时只能用 navigator.sendBeacon，**它无法设置请求头**，
 *            也来不及等 fetch(keepalive) 的响应，只能把 key 拼在 URL 上
 *
 * 两者同时出现时以 header 为准：URL 会被写进访问日志、Referer、浏览器历史，
 * 是"更容易被抄走"的那条路，既然请求已经带了更安全的那个，就用它。
 *
 * 注意这里**只取不验**：格式合法性、是否吊销、属于哪个项目，全部交给 KeysService。
 * 认证逻辑散落在控制器里是 TC-05 最容易被破坏的地方。
 */
export function extractIngestKey(req: Request): string | undefined {
  const header = req.headers['x-argus-key'];
  // Node 里同名请求头可以出现多次，此时 header 会是数组
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader !== undefined && fromHeader.trim() !== '') return fromHeader.trim();

  const { key } = req.query as { key?: unknown };
  // ?key=a&key=b 时 express 给的是数组，取第一个
  const raw = Array.isArray(key) ? key[0] : key;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();

  return undefined;
}
