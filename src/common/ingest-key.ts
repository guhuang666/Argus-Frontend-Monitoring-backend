import type { Request } from 'express';

/**
 * 从上报请求里取出公钥。**只认请求头 `X-Argus-Key`。**
 *
 * ── 为什么砍掉了 `?key=` ────────────────────────────────────────────────
 * SRS 原本为 `navigator.sendBeacon` 留了这条退场通道（那个 API 设不了请求头），
 * 但本项目**从未实现 sendBeacon 降级**，SDK 只用 `fetch` 发请求。
 * 于是"服务端收 query"变成了一条只有收端、没有发端的死代码 ——
 * 它不会带来功能，只会让读代码的人以为"这条通道在用"，还会让多一条
 * 凭据进入访问日志 / Referer / 浏览器历史的路径。
 *
 * 真要做退场通道时再把它加回来（届时 SRS 的 FR-2.2 也一并更新）。
 *
 * ── 关于 trim ───────────────────────────────────────────────────────────
 * 从终端复制密钥常带尾随空格或换行。不 trim 的话 `"argus_pub_xxx\n"`
 * 去查库查不到，报"密钥无效"，而用户看着自己的 key 明明是对的。
 *
 * ── 只取不验 ────────────────────────────────────────────────────────────
 * 格式、是否吊销、属于哪个项目，全部交给 KeysService。
 * 认证逻辑散落在控制器里是 TC-05 最容易被破坏的地方。
 */
export function extractIngestKey(req: Request): string | undefined {
  const header = req.headers['x-argus-key'];
  // @types/node 把请求头声明成 string | string[] | undefined（set-cookie 那种会重复
  // 的头是数组），所以这里必须处理数组分支才能过类型检查。实际运行时
  // 同名普通头会被 Node 拼成 "a, b" 一个字符串，这个分支几乎不会命中。
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
