import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password';

/**
 * 密码哈希的用例。
 *
 * 重点不在"对的总能过"，而在三条容易被改坏的约束：
 *   ① 同一密码两次哈希必须不同（盐随机）—— 否则彩虹表又能用了
 *   ② 坏数据只许返回 false，不许抛 —— 否则登录接口会因为一行脏数据 500
 *   ③ 假摘要必须真的能跑完一次 scrypt —— 否则"耗时拉平"这个防护等于没做
 */

describe('hashPassword / verifyPassword', () => {
  it('格式是 scrypt$N$r$p$salt$hash，且参数一起存下来', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const parts = hash.split('$');

    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBe(16384);
    expect(Number(parts[2])).toBe(8);
    expect(Number(parts[3])).toBe(1);
    // 盐和摘要是 base64url，不应出现 + / =
    expect(parts[4]).not.toMatch(/[+/=]/);
    expect(parts[5]).not.toMatch(/[+/=]/);
  });

  it('同一密码两次哈希不同（盐随机）', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');

    expect(a).not.toBe(b);
    // 但两者都能验过
    expect(await verifyPassword('same-password-123', a)).toBe(true);
    expect(await verifyPassword('same-password-123', b)).toBe(true);
  });

  it('正确密码通过、错误密码不通过', async () => {
    const hash = await hashPassword('MyPassw0rd!');
    expect(await verifyPassword('MyPassw0rd!', hash)).toBe(true);
    expect(await verifyPassword('mypassw0rd!', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('支持中文与 128 字符长密码（UTF-8 边界）', async () => {
    const cn = '这是一个很长的中文密码-测试编码';
    const long = 'a'.repeat(128);
    expect(await verifyPassword(cn, await hashPassword(cn))).toBe(true);
    expect(await verifyPassword(long, await hashPassword(long))).toBe(true);
  });

  it('脏数据一律返回 false，绝不抛异常', async () => {
    const broken = [
      '',
      'not-a-hash',
      'scrypt$16384$8$1$onlyfiveparts',
      'bcrypt$16384$8$1$c2FsdA$aGFzaA', // 算法名不对
      'scrypt$NaN$8$1$c2FsdA$aGFzaA', // 参数不是数字
      'scrypt$16384$8$1$$', // 盐和摘要都空
      'scrypt$999999999$8$1$c2FsdA$aGFzaA', // N 超出 maxmem，scrypt 会抛
    ];

    for (const stored of broken) {
      await expect(verifyPassword('whatever', stored)).resolves.toBe(false);
    }
  });

  it('假摘要能完整跑一次 scrypt 后返回 false（耗时拉平的前提）', async () => {
    const started = Date.now();
    const result = await verifyPassword('any-password-at-all', DUMMY_PASSWORD_HASH);
    const elapsed = Date.now() - started;

    expect(result).toBe(false);
    // 真跑过一次才会有这个量级的耗时；如果它只是个格式错误，
    // 会立刻返回 0~1ms，"账号不存在"的探测窗口就回来了
    expect(elapsed).toBeGreaterThan(1);
  });
});
