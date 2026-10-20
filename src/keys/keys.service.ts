import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashSecret } from '../common/keys';

/** 公钥 → 项目 的缓存时间。吊销 key 后最多延迟这么久才生效，可接受 */
const CACHE_TTL_MS = 30_000;

/**
 * 密钥解析（S2）—— 把"一段字符串"翻译成"哪个项目"。
 *
 * ── 两条链路，各走各的方法 ──────────────────────────────────────────────
 *   resolveProjectByPublicKey：SDK 上报用。公开、高频 → 必须缓存
 *   resolveProjectBySecret：CLI 上传 Sourcemap 用。私密、低频 → 不缓存
 *
 * 两者是对称的：公钥和私钥都是**项目级**凭据，各自唯一索引一条，反查一次
 * 就得到 projectId。所以上传接口不再需要客户端告诉服务端"我是哪个项目"。
 *
 * ── 为什么公钥要缓存 ────────────────────────────────────────────────────
 * 上报热路径每秒可能上千次，每次都查库就为了拿一个几乎不变的 projectId。
 * 缓存键是公钥原文，值只存 projectId —— 不缓存密钥行本身，避免把哈希留在内存里。
 */
@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name);

  /** publicKey → projectId。吊销后靠 30 秒 TTL 自动失效 */
  private readonly publicKeyCache = new Map<string, { projectId: string; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 上报鉴权：公钥 → 项目 id。
   *
   * 查不到、已吊销、或压根没带 → 401（FR-5.7：不确定的情况一律拒绝）。
   */
  async resolveProjectByPublicKey(publicKey: string | undefined): Promise<string> {
    const key = publicKey?.trim();
    if (key === undefined || key === '') {
      throw new UnauthorizedException(
        '缺少上报密钥：请求头 X-Argus-Key 或查询参数 ?key=（退场通道只能用 query）',
      );
    }

    const hit = this.publicKeyCache.get(key);
    if (hit !== undefined && hit.expiresAt > Date.now()) return hit.projectId;

    const row = await this.prisma.projectKey.findFirst({
      where: {
        publicKey: key,
        // 未吊销，或还在宽限期内
        OR: [{ revokedAt: null }, { revokedAt: { gt: new Date() } }],
      },
      select: { projectId: true },
    });

    if (row === null) {
      // 不在报错信息里区分"不存在"和"已吊销"：两者对外都是 401，避免探测
      throw new UnauthorizedException('上报密钥无效或已吊销');
    }

    this.publicKeyCache.set(key, {
      projectId: row.projectId,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return row.projectId;
  }

  /**
   * 管理鉴权：校验私钥是否属于这个项目。
   *
   * 不缓存：私钥吊销必须立刻生效（上传是一次性动作，多查一次库无所谓）。
   * 允许同时存在多把有效私钥 —— 这正是轮换宽限期需要的。
   */
  /**
   * 上传鉴权：私钥 → 项目 id。
   *
   * 这是"私钥即身份"的直接实现 —— 客户端只给一把私钥，服务端反查出它是
   * 哪个项目的，调用方**没有机会说错项目**。
   *
   * ── 关于常量时间比较 ────────────────────────────────────────────────────
   * 旧实现在项目内把所有候选哈希逐把做 `timingSafeEqual`。
   * 现在改成一次索引等值查询 `secret_key_hash = sha256(私钥)`。
   *
   * 这不会削弱安全性：我们比较的是一个 128 位随机数的 sha256 摘要，
   * 攻击者无法通过 B 树查找的耗时去逐字节试探（他要试的是原像，不是摘要前缀）。
   * 真正需要常量时间比较的场景是"秘密本身直接参与比较"，这里不是。
   *
   * ── 为什么仍然把 Bearer 前缀剥掉 ────────────────────────────────────────
   * 让 curl / CI 都按 HTTP 惯例写 `Authorization: Bearer <私钥>`，
   * 而不是要求它们只发裸串。
   */
  async resolveProjectBySecret(secret: string | undefined): Promise<string> {
    const raw = secret?.replace(/^Bearer\s+/i, '').trim();
    if (raw === undefined || raw === '') {
      throw new UnauthorizedException('缺少私钥：请求头 Authorization: Bearer <argus_sec_...>');
    }

    const row = await this.prisma.projectKey.findFirst({
      where: {
        secretKeyHash: hashSecret(raw),
        // 未吊销，或在宽限期内
        OR: [{ revokedAt: null }, { revokedAt: { gt: new Date() } }],
      },
      select: { projectId: true },
    });

    if (row === null) {
      // 不在报错里区分"私钥不存在"和"已吊销" —— 对外都是 401，避免探测
      this.logger.warn('私钥解析失败（无效或已吊销）');
      throw new UnauthorizedException('私钥不正确或已吊销');
    }

    return row.projectId;
  }
}
