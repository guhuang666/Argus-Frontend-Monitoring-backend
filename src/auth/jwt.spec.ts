import { createHmac } from 'node:crypto';
import { verifyJwt, signJwt } from './jwt';

/**
 * JWT 的攻防用例。
 *
 * 这些不是"顺便测一下能不能用"，每一条都对应一种**真实存在过的** JWT 攻击面：
 *   · alg:none          —— 把算法改成 none、签名留空，实现若"按头里说的做"就直接放行
 *   · 载荷篡改          —— 只改 exp 不改签名（或改了签名但没验）
 *   · 算法混淆          —— 声称用公钥当 HMAC 密钥（RS256→HS256），HS256 实现必须只认自己
 *   · 时钟               —— 差一点才算过期，别让 NTP 微调把人踢下线
 *
 * 手写 JWT 的全部风险都在这几条里。写实现时脑子里要装着它们，写用例是为了
 * 以后有人改这几行代码时，能立刻知道自己破坏了什么。
 */

const SECRET = 'test-secret-must-be-long-enough-32ch';

/** 把三段式 token 的某一段替换掉，制造一个"结构合法但内容不对"的 token */
function replacePart(token: string, index: number, value: string): string {
  const parts = token.split('.');
  parts[index] = Buffer.from(value).toString('base64url');
  return parts.join('.');
}

describe('signJwt / verifyJwt', () => {
  it('正常签发后能验回同一个 sub', () => {
    const token = signJwt('user-123', SECRET, 60, 1000);
    const result = verifyJwt(token, SECRET, 1000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('user-123');
      expect(result.payload.iat).toBe(1000);
      expect(result.payload.exp).toBe(1060);
    }
  });

  it('载荷被篡改（比如把 exp 推后一年）→ 签名不匹配', () => {
    const token = signJwt('user-123', SECRET, 60, 1000);
    const forged = replacePart(token, 1, JSON.stringify({ sub: 'user-123', iat: 1000, exp: 9e9 }));

    const result = verifyJwt(forged, SECRET, 1000);
    expect(result).toEqual({ ok: false, reason: '签名不匹配' });
  });

  it('签名段被改 → 签名不匹配', () => {
    const token = signJwt('user-123', SECRET, 60, 1000);
    const parts = token.split('.');
    parts[2] = Buffer.from('not-the-real-signature-00000000').toString('base64url');

    expect(verifyJwt(parts.join('.'), SECRET, 1000).ok).toBe(false);
  });

  it('换一个密钥签的 token → 签名不匹配（密钥没配错也能挡）', () => {
    const token = signJwt('user-123', 'another-secret-also-long-enough-32', 60, 1000);
    const result = verifyJwt(token, SECRET, 1000);

    expect(result).toEqual({ ok: false, reason: '签名不匹配' });
  });

  it('alg: none 攻击 → 直接拒绝', () => {
    // 手工拼一个 alg=none、签名段为空串的 token。这是 JWT 历史上最著名的一类漏洞
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'attacker', iat: 1000, exp: 9e9 }),
    ).toString('base64url');

    const result = verifyJwt(`${header}.${payload}.`, SECRET, 1000);
    expect(result).toEqual({ ok: false, reason: '不支持的签名算法' });
  });

  it('alg: HS512 也不认（只认自己实现的那一种）', () => {
    const token = signJwt('user-123', SECRET, 60, 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const forged = [header, token.split('.')[1], token.split('.')[2]].join('.');

    expect(verifyJwt(forged, SECRET, 1000)).toEqual({
      ok: false,
      reason: '不支持的签名算法',
    });
  });

  it('过期 → 已过期', () => {
    const token = signJwt('user-123', SECRET, 60, 1000);
    // 签发后 60 秒过期，容忍 30 秒偏移 → 1000+60+30 = 1090 之后必然过期
    expect(verifyJwt(token, SECRET, 1091)).toEqual({ ok: false, reason: '已过期' });
  });

  it('刚过期 10 秒仍然放行（时钟容差，避免 NTP 微调把人踢下线）', () => {
    const token = signJwt('user-123', SECRET, 60, 1000);
    expect(verifyJwt(token, SECRET, 1065).ok).toBe(true);
  });

  it('签发时间在遥远的未来 → 拒绝（可能是手工伪造或时钟错乱）', () => {
    const token = signJwt('user-123', SECRET, 60, 10_000);
    expect(verifyJwt(token, SECRET, 1000)).toEqual({
      ok: false,
      reason: '签发时间在未来',
    });
  });

  it('段数不对 → 格式不正确', () => {
    expect(verifyJwt('only-one-part', SECRET, 1000)).toEqual({
      ok: false,
      reason: '格式不正确',
    });
    expect(verifyJwt('a.b.c.d', SECRET, 1000)).toEqual({ ok: false, reason: '格式不正确' });
  });

  it('头部 / 载荷不是合法 JSON → 各自给出明确原因', () => {
    const token = signJwt('user-123', SECRET, 60, 1000);
    const badHeader = replacePart(token, 0, 'not-json');
    expect(verifyJwt(badHeader, SECRET, 1000)).toEqual({
      ok: false,
      reason: '头部不是合法 JSON',
    });
  });

  it('签名正确但载荷缺 sub → 拒绝（不是所有"验签通过"的 token 都合法）', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: 1000, exp: 9999 })).toString('base64url');
    const head = `${header}.${payload}`;
    // 用真密钥算真签名，确保失败原因只可能是"缺 sub"
    const sig = createHmac('sha256', SECRET).update(head, 'utf8').digest('base64url');

    expect(verifyJwt(`${head}.${sig}`, SECRET, 1000)).toEqual({ ok: false, reason: '缺少 sub' });
  });
});
