import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 项目（租户）的读取。
 *
 * ── 为什么 M4-S2 就需要它 ────────────────────────────────────────────────
 * 一旦上报要靠公钥区分项目，人就必须有一条路径去**看到那个公钥** ——
 * 否则每个新项目都得进数据库抄一遍。看板 S3 的项目切换器也读这里。
 *
 * ── 为什么不返回私钥 ────────────────────────────────────────────────────
 * 库里只有它的 sha256，本来也返回不了。私钥只在生成的那一刻出现过一次
 * （`npm run project:new` 的标准输出），之后任何人——包括运维——都拿不到。
 * 这是有意的：能重新读出来的密钥，等于没有密钥。
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 项目列表。
   *
   * 只取"未吊销"的那把公钥：一个项目轮换过 key 之后会同时存在多行
   * project_keys，但 SDK 配置里该填的只有当前这一把。
   * 用 orderBy createdAt asc + 取第一条，保证同一项目每次返回同一把
   * （否则切换器里的 DSN 会随机跳动）。
   */
  async list() {
    const rows = await this.prisma.project.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        keys: {
          where: { revokedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { publicKey: true },
        },
        _count: { select: { errorGroups: true, errorEvents: true } },
      },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        // Decimal → number：Prisma 的 Decimal 对象经 JSON.stringify 会变成
        // {"s":1,"e":0,"d":[1]} 这种形状，看板拿到没法直接用
        sample_rate: Number(row.sampleRate),
        rate_limit_per_sec: row.rateLimitPerSec,
        is_active: row.isActive,
        created_at: row.createdAt,
        public_key: row.keys[0]?.publicKey ?? null,
        issue_count: row._count.errorGroups,
        event_count: row._count.errorEvents,
      })),
    };
  }

  async getById(id: string) {
    const row = await this.prisma.project.findUnique({
      where: { id },
      include: { keys: { where: { revokedAt: null }, orderBy: { createdAt: 'asc' } } },
    });
    if (row === null) {
      throw new NotFoundException(`项目不存在: ${id}`);
    }

    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      sample_rate: Number(row.sampleRate),
      rate_limit_per_sec: row.rateLimitPerSec,
      is_active: row.isActive,
      created_at: row.createdAt,
      // 详情里给出全部有效公钥（轮换期会有两把，前端可以标注哪把是新的）
      public_keys: row.keys.map((key) => ({
        public_key: key.publicKey,
        label: key.label,
        created_at: key.createdAt,
      })),
    };
  }
}
