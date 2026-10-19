import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 密码哈希（FR-5.4）。
 *
 * ── 为什么用 scrypt，不用 sha256 ─────────────────────────────────────────
 * 私钥（common/keys.ts）用 sha256 就够了，因为它是 128 位随机数 —— 猜不出来，
 * 也就不需要"算得慢"。**密码是另一回事**：人的密码来自一个很窄的分布
 * （`password123`、`12345678`……），攻击者拿一张几亿条的彩虹表，一次 sha256
 * 就能对上几百万个真实密码。
 *
 * scrypt 是故意"算得慢、还占内存"的：N=16384 时每次约十几毫秒、16MB 内存。
 * 正常登录感觉不到；而攻击者想试十亿次，成本会高到他放弃。
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** CPU/内存成本。调大更安全但更慢；16384 是 Node 默认 maxmem(32MB) 下的稳妥值 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

/**
 * 明文 → 可入库的摘要字符串。
 *
 * 格式：`scrypt$N$r$p$<salt>$<hash>`（后两段是 base64url）
 *
 * 把参数一起存进去，是为了**以后能升级参数而不作废旧密码**：
 * 校验时读回这一行里的 N/r/p，就能判断"这条是旧参数算的"，登录成功后
 * 顺便用新参数重算一遍即可。如果参数写死在代码里，改一次就等于让所有人重置密码。
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(plain, salt, KEY_LEN, { N, r: R, p: P });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * 校验密码。任何格式问题都返回 false，绝不抛异常。
 *
 * 为什么不能让异常冒出去：登录接口里"这一行数据坏了"和"密码不对"对外必须
 * 是同一个结果（401），否则错误信息本身就成了一种探测手段。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  // 参数来自数据库，理论上可能被改坏。非正数会让 scrypt 直接抛，先拦下
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scryptAsync(plain, salt, expected.length, { N: n, r, p });
    // 常量时间比较：普通 === 会在第一个不同的字节返回，能靠耗时逐字节猜
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    // 参数超出 maxmem 之类的情况
    return false;
  }
}

/**
 * 一个固定的"假摘要"，用来在**账号不存在时也完整跑一次 scrypt**。
 *
 * 不这么做的话，登录接口的耗时会区分"用户存在"（十几毫秒）和"用户不存在"（几乎瞬时），
 * 攻击者据此就能批量探测哪些邮箱注册过。这叫用户枚举，属于信息泄露。
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'Zm9yLXRpbWluZy1lcXVhbGl6YXRpb24tb25seS1uZXZlci1hLXJlYWwtcGFzc3dvcmQ';
