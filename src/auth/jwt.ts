import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 手写的最小 HS256 JWT（FR-5.4）。
 *
 * ── 为什么不上 jsonwebtoken / @nestjs/jwt ────────────────────────────────
 * JWT 的全部内容是：`base64url(头).base64url(载荷).HMAC-SHA256(前两段)`。
 * 这三十行代码就是完整实现，依赖省下来的是"不引入一个自己没读过的安全组件"。
 *
 * 但要说清楚这条路的代价，别把它当免费午餐：
 *   · 必须自己防住 `alg: none` 攻击（下面有用例钉着）
 *   · 必须自己用常量时间比较签名
 *   · 必须自己想清楚时钟偏移和过期判断
 *   · 不支持 RS256 非对称签名、不支持 JWKS 轮换密钥
 * 对"单机部署、只签发给自己人用"的看板，这些都用不上。真要做多服务对接，
 * 换成 jose / @nestjs/jwt 才是正解 —— 那里面的坑比这三十行多得多。
 */

/** 默认有效期：7 天。看板是低频使用的工具，12 小时会让人烦到关掉页面 */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * 校验时容忍的时钟偏移（秒）。
 *
 * 签发方和校验方是同一台机器，理论上用不到。但浏览器传来的 token 不参与
 * 时间判断，而服务器时区/时钟被 NTP 微调过也很正常。给 30 秒容错，
 * 换掉"明明没过期却被判过期"这类最难复现的问题。
 */
const CLOCK_LEEWAY_SECONDS = 30;

export interface JwtPayload {
  /** subject：用户 id */
  sub: string;
  /** issued at：签发时间（秒） */
  iat: number;
  /** expires at：过期时间（秒） */
  exp: number;
}

export type VerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: string };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data, 'utf8').digest();
}

/**
 * 签发。
 *
 * 载荷里**只有 sub**，不塞邮箱、不塞角色、不塞组织 id。三个理由：
 *   ① JWT 是 base64 而不是加密，塞进去的每个字段都是公开的
 *   ② 角色/成员关系会变，塞进 token 就等于"改了成员要等 7 天 token 过期才生效"
 *   ③ 需要什么就现查 —— 一次数据库查询，换"永远是新的"
 */
export function signJwt(
  subject: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JwtPayload = {
    sub: subject,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${head}.${b64url(hmac(head, secret))}`;
}

/**
 * 校验。**任何一步不对都返回 ok:false**，不抛异常、不区分"哪一步错了"。
 *
 * 顺序是有讲究的：
 *   ① 先拆三段 —— 形状不对就没必要往下算
 *   ② 先验签名、再看载荷 —— 否则等于"先相信攻击者给的过期时间"
 *   ③ 签名过了才解析 JSON —— 载荷内容从这一刻起才可信
 *
 * 第 ② 步之前**绝不能读载荷里的任何字段**（哪怕只是看一眼 exp）。
 * 攻击者能随手构造一个 exp 在 100 年后的载荷，它的签名是假的。
 */
export function verifyJwt(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: '格式不正确' };

  const [headB64, payloadB64, sigB64] = parts;

  // ── 头：只认 HS256 ──
  // 这一条挡的是经典的 "alg: none" 攻击：攻击者把 alg 改成 none、并把签名段
  // 留空，某些实现会"按算法说的做"—— 不校验。这里直接白名单，认不出就拒。
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: '头部不是合法 JSON' };
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as { alg?: unknown }).alg !== 'HS256'
  ) {
    return { ok: false, reason: '不支持的签名算法' };
  }

  // ── 签名：常量时间比较 ──
  const expected = hmac(`${headB64}.${payloadB64}`, secret);
  const actual = Buffer.from(sigB64, 'base64url');
  // 长度不等时 timingSafeEqual 会直接抛，所以先比长度。
  // 长度不是秘密（HS256 恒为 32 字节），这里泄漏不了信息
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: '签名不匹配' };
  }

  // ── 载荷：签名已经验过，这里读到的内容可以信 ──
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: '载荷不是合法 JSON' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: '载荷形状不正确' };
  }

  const { sub, iat, exp } = payload as Partial<JwtPayload>;
  if (typeof sub !== 'string' || sub === '') return { ok: false, reason: '缺少 sub' };
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: '缺少 exp' };
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return { ok: false, reason: '缺少 iat' };

  if (exp + CLOCK_LEEWAY_SECONDS <= nowSeconds) return { ok: false, reason: '已过期' };
  // iat 在未来说明签发方时钟有问题，或者有人手工造了 token
  if (iat - CLOCK_LEEWAY_SECONDS > nowSeconds) return { ok: false, reason: '签发时间在未来' };

  return { ok: true, payload: { sub, iat, exp } };
}
