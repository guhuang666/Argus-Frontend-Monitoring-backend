import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_TTL_SECONDS, signJwt, verifyJwt } from './jwt';
import type { VerifyResult } from './jwt';

/** HS256 的密钥长度下限。32 字符 ≈ 与 sha256 的 32 字节等长，低于这个值等于自降强度 */
const MIN_SECRET_LENGTH = 32;

/**
 * JWT 的签发与校验封装。
 *
 * ── fail closed ──────────────────────────────────────────────────────────
 * 没配 `JWT_SECRET`（或太短）时**构造函数直接抛错，进程起不来**。
 * 不给默认值、不生成临时密钥 —— 后者更危险：每次重启都换密钥，
 * 表现为"用户莫名其妙被登出"，而且日志里什么都看不到。
 *
 * 这是个前车之鉴：M3 那份 sourcemap 上传的实现就是"没配 ARGUS_TOKEN 就拒绝"，
 * 而不是"没配就放行"。同一套立场。
 */
@Injectable()
export class JwtService {
  private readonly logger = new Logger(JwtService.name);
  private readonly secret: string;

  constructor() {
    const secret = process.env.JWT_SECRET?.trim();

    if (secret === undefined || secret === '') {
      throw new Error(
        'JWT_SECRET 未配置，鉴权接口无法启动（fail closed）。\n' +
          '  生成一个：node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"\n' +
          '  然后写进 backend/.env',
      );
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET 太短（${secret.length} < ${MIN_SECRET_LENGTH}）。` +
          '短密钥的签名可被离线爆破，等于没有签名',
      );
    }

    this.secret = secret;
    // 不打印密钥本身，只打印长度 —— 日志会被截图、会被贴进 issue
    this.logger.log(`JWT 已就绪（HS256，密钥 ${secret.length} 字符）`);
  }

  /** 签发。ttl 可覆盖，默认 7 天 */
  sign(userId: string, ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    return {
      token: signJwt(userId, this.secret, ttlSeconds),
      expiresIn: ttlSeconds,
    };
  }

  verify(token: string): VerifyResult {
    return verifyJwt(token, this.secret);
  }
}
