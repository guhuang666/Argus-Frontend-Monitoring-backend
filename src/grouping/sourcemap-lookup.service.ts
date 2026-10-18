import { Injectable, Logger } from '@nestjs/common';
import { TraceMap } from '@jridgewell/trace-mapping';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { uploadsRoot } from '../sourcemaps/sourcemaps.constants';
import type { Frame } from './fingerprint';
import { symbolicateFrames } from './symbolicate';
import type { SymbolicationResult } from './symbolicate';

/**
 * Sourcemap 查找服务（M3 / FR-3.4）—— 符号化里**唯一碰 I/O 的地方**。
 *
 * 分工：
 *   symbolicate.ts          纯逻辑：帧 + map → 源码位置（可单测）
 *   本文件                  查库、读盘、缓存（不可单测，靠集成验证）
 *
 * ── 为什么不放在 sourcemaps/ 目录 ────────────────────────────────────────
 * sourcemaps/ 目前是**上传侧**（API 进程的 HTTP 入口）。本服务只给 Worker 用，
 * 放进 grouping/ 才不会让"上传"和"消费"的依赖混在一起。它读的仍是
 * sourcemaps.constants 里的 uploadsRoot —— 那是两边共享的存储约定。
 *
 * ── 三层缓存，慢的都在后面 ───────────────────────────────────────────────
 *   ① release → 产物路径映射表     30 秒，避免每条事件都查两次库
 *   ② sourcemapPath → TraceMap     按文件内容哈希命名，天然不可变，长驻
 * 解析一张 5MB 的 map 要几十到上百毫秒，所以第 ② 层是性能的关键：
 * 同一个 release 的第一条事件付一次解析成本，之后全命中。
 *
 * ── 失败即降级，绝不抛 ──────────────────────────────────────────────────
 * 符号化是**锦上添花**：map 缺失、文件被删、JSON 损坏，都只应让这一帧显示
 * 压缩位置（FR-3.9），不能让整条事件的归并失败 —— 那会把它推进 DLQ，
 * 而数据本身其实没问题。
 */
@Injectable()
export class SourcemapLookupService {
  private readonly logger = new Logger(SourcemapLookupService.name);

  /** release 版本号 → 该版本所有产物到 map 的映射。TTL 是为了让新上传的 map 能被看到 */
  private readonly releaseCache = new Map<
    string,
    { expiresAt: number; byArtifact: Map<string, string> }
  >();

  /** sourcemapPath（内容哈希命名）→ 已解析的 map。内容不可变，所以不需要过期 */
  private readonly mapCache = new Map<string, TraceMap>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 把一堆压缩帧还原成源码位置。
   *
   * @param db      事务客户端 —— 与声明事件共用同一条连接：
   *                在 $transaction 里另开连接池连接，并发高时会自己把自己卡住
   * @param release 事件的版本号；null 直接降级（没有版本就无从匹配）
   * @param frames  parseFrames() 的产物
   */
  async symbolicate(
    db: Prisma.TransactionClient,
    release: string | null,
    frames: Frame[],
  ): Promise<SymbolicationResult> {
    // 没有版本 / 没有帧（resource 通道）→ 不必查库，直接全量降级
    if (release === null || frames.length === 0) {
      return symbolicateFrames(frames, () => null);
    }

    const byArtifact = await this.mapsFor(db, release);
    if (byArtifact.size === 0) {
      return symbolicateFrames(frames, () => null);
    }

    return symbolicateFrames(frames, (artifactPath) => {
      const relativePath = byArtifact.get(artifactPath);
      return relativePath === undefined ? null : this.loadMap(relativePath);
    });
  }

  /** release → (artifact_path → sourcemap_path)。带 TTL 缓存，空结果也缓存 */
  private async mapsFor(
    db: Prisma.TransactionClient,
    release: string,
  ): Promise<Map<string, string>> {
    const hit = this.releaseCache.get(release);
    if (hit !== undefined && hit.expiresAt > Date.now()) {
      return hit.byArtifact;
    }

    const byArtifact = new Map<string, string>();

    try {
      const row = await db.release.findUnique({
        where: { version: release },
        select: { id: true },
      });

      if (row !== null) {
        const files = await db.sourcemapFile.findMany({
          where: { releaseId: row.id },
          select: { artifactPath: true, sourcemapPath: true },
        });
        for (const file of files) {
          byArtifact.set(file.artifactPath, file.sourcemapPath);
        }
      }
    } catch (err) {
      // 查库失败也降级：这一条按未符号化处理，下一条会重新查
      this.logger.warn(
        `查询 Sourcemap 失败，本次按未符号化处理: release=${release} — ${String(err)}`,
      );
      return new Map();
    }

    if (byArtifact.size === 0) {
      // 缓存"这个版本还没有 map"，避免每条事件都查一遍库。
      // TTL 到期后重新查 —— 那时用户可能刚上传完
      this.logger.debug(
        `release=${release} 暂无 Sourcemap，本次按未符号化处理`,
      );
    }

    this.rememberRelease(release, byArtifact);
    return byArtifact;
  }

  private rememberRelease(
    release: string,
    byArtifact: Map<string, string>,
  ): void {
    const RELEASE_CACHE_TTL_MS = 30_000;
    const MAX_CACHED_RELEASES = 32;

    if (this.releaseCache.size >= MAX_CACHED_RELEASES) {
      // 简单 FIFO 淘汰：Map 保持插入顺序，删最早那个。
      // 用展开而不是 keys().next().value —— 后者的类型在 type-aware lint 里是 any
      const oldest = [...this.releaseCache.keys()][0];
      if (oldest !== undefined) this.releaseCache.delete(oldest);
    }

    this.releaseCache.set(release, {
      expiresAt: Date.now() + RELEASE_CACHE_TTL_MS,
      byArtifact,
    });
  }

  /** 读盘 + 解析一张 map。失败返回 null，永不抛 */
  private loadMap(relativePath: string): TraceMap | null {
    const cached = this.mapCache.get(relativePath);
    if (cached !== undefined) return cached;

    try {
      const json = readFileSync(join(uploadsRoot(), relativePath), 'utf8');
      const map = new TraceMap(json);

      const MAX_CACHED_MAPS = 64;
      if (this.mapCache.size >= MAX_CACHED_MAPS) {
        const oldest = [...this.mapCache.keys()][0];
        if (oldest !== undefined) this.mapCache.delete(oldest);
      }
      this.mapCache.set(relativePath, map);
      return map;
    } catch (err) {
      // 文件被删 / JSON 损坏 / 权限问题 —— 这一帧按未符号化处理即可
      this.logger.warn(
        `读取 Sourcemap 失败，该帧按未符号化处理: ${relativePath} — ${String(err)}`,
      );
      return null;
    }
  }
}
