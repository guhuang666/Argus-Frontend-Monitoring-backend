import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashSecret, safeEqual } from '../common/keys';

/** 公钥 → 项目 的缓存时间。吊销 key 后最多延迟这么久才生效，可接受 */
const CACHE_TTL_MS = 30_000;

/**
 * 密钥解析（S2）—— 把"一段字符串"翻译成"哪个项目"。
 *
 * ── 两条链路，各走各的方法 ──────────────────────────────────────────────
 *   resolveProjectByPublicKey：SDK 上报用。公开、高频 → 必须缓存
 *   assertSecret：CLI 上传 / 管理操作用。私密、低频 → 不缓存（吊销立即生效）
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
  async assertSecret(projectId: string, secret: string | undefined): Promise<void> {
    const raw = secret?.replace(/^Bearer\s+/i, '').trim();
    if (raw === undefined || raw === '') {
      throw new UnauthorizedException('缺少私钥：请求头 Authorization: Bearer <argus_sec_...>');
    }

    const candidates = await this.prisma.projectKey.findMany({
      where: {
        projectId,
        OR: [{ revokedAt: null }, { revokedAt: { gt: new Date() } }],
      },
      select: { secretKeyHash: true },
    });

    const hash = hashSecret(raw);
    // 逐把比较（常量时间）。不能用库查询直接比对哈希 —— 那会变成一次等值查询，
    // 时序不可控；而且这里条数极少（轮换期最多两三把）。
    const ok = candidates.some((row) => safeEqual(row.secretKeyHash, hash));
    if (!ok) {
      this.logger.warn(`私钥校验失败: project=${projectId}`);
      throw new UnauthorizedException('私钥不正确，或不属于该项目');
    }
  }
}
