import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 项目密钥的格式与哈希。
 *
 * ── 两种钥匙，能力边界在后面反而比格式更重要 ────────────────────────────
 *   公钥 argus_pub_<32hex>  只能"往这一个项目写事件"，明文存储（要展示给用户）
 *   私钥 argus_sec_<32hex>  能"管理这一个项目"（上传 map、改配置），只存哈希
 *
 * 判断一段凭证能不能放进浏览器，标准不是它的名字，而是**泄露后的最坏后果**：
 * 公钥泄露只是"别人能往你项目灌垃圾"（有上限、可轮换），私钥泄露则是
 * "别人能伪造你看到的所有堆栈"——所以它只能待在 CI / 本地。
 */

const PUBLIC_PREFIX = 'argus_pub_';
const SECRET_PREFIX = 'argus_sec_';

/** 16 字节随机 → 32 位十六进制 */
function randomToken(): string {
  return randomBytes(16).toString('hex');
}

export function generatePublicKey(): string {
  return `${PUBLIC_PREFIX}${randomToken()}`;
}

export function generateSecretKey(): string {
  return `${SECRET_PREFIX}${randomToken()}`;
}

/**
 * 私钥 → 可入库的哈希。
 *
 * 用 sha256 而不是 bcrypt/scrypt：私钥是 128 位随机串，不是人选的密码，
 * 不存在"字典攻击"的余地；用慢哈希只会让每次上传多花几十毫秒。
 * （用户密码是另一回事 —— 那个必须用 scrypt/bcrypt。）
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * 常量时间比较，防时序侧信道。
 *
 * 直接 `===` 会在第一个不同的字节就返回，攻击者能靠耗时差异逐字节猜出哈希。
 * 两边长度不同时先哈希到定长，避免"长度不同"本身泄漏信息。
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
