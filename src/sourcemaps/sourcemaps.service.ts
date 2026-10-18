import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { checkArtifactPath } from './artifact-path';
import type { MulterFile } from './multer-file';
import { uploadsRoot } from './sourcemaps.constants';

/** 上传入参（controller 归一化之后的样子） */
export interface UploadSourcemapInput {
  release: string;
  artifactPath: string;
  file: MulterFile;
  token: string | undefined;
}

/** 上传结果，直接作为 201 响应体 */
export interface UploadSourcemapResult {
  release_id: string;
  artifact_path: string;
  size_bytes: number;
  /** true = 这个 (release, artifact_path) 之前传过，本次是覆盖而非新增 */
  reused: boolean;
}

/**
 * Sourcemap 上传（M3 / FR-3.2、FR-3.3、FR-3.4）。
 *
 * ── 六步流水线 ──────────────────────────────────────────────────────────
 *   ① 校验 token          —— 常量时间比较，不打印 token
 *   ② 校验 artifact_path  —— 规则在 artifact-path.ts，三个使用方共用
 *   ③ release upsert      —— version 唯一，已存在就复用
 *   ④ 落盘                —— uploads/<releaseId>/<内容哈希>.map
 *   ⑤ sourcemap_files 写库 —— create 撞 P2002 再 update（同 error-events 的既有写法）
 *   ⑥ 失败清理            —— ⑤ 挂了要删掉 ④ 写的文件，但**只删本次新建的**
 *
 * ── 为什么用内容哈希做文件名 ────────────────────────────────────────────
 * 同一个 map 重传时落到同一个路径，天然幂等（覆盖 = 无操作）；不同 artifact
 * 共用同一份 map 时也只存一份（内容寻址）。代价是 `ls uploads/` 看到的是哈希，
 * 可读性差 —— 但 artifact_path 存在 DB 里，随时能查回来。
 */
@Injectable()
export class SourcemapsService {
  private readonly logger = new Logger(SourcemapsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upload(input: UploadSourcemapInput): Promise<UploadSourcemapResult> {
    // ── ① token ──
    this.assertToken(input.token);

    // ── ② artifact_path ──
    const checked = checkArtifactPath(input.artifactPath);
    if (!checked.ok) {
      throw new BadRequestException(`artifact_path 不合法（${checked.error}）: ${checked.message}`);
    }
    const artifactPath = checked.path;

    // ── ③ release（version 唯一，已存在就复用）──
    const release = await this.prisma.release.upsert({
      where: { version: input.release },
      update: {},
      create: { version: input.release },
      select: { id: true, version: true },
    });

    // ── ④ 落盘 ──
    const buffer = input.file.buffer;
    const hash = createHash('sha256').update(buffer).digest('hex');
    // 相对 uploadsRoot 存，DB 里也只存这一段 —— 以后换存储根（挂载盘/对象存储）
    // 不会让历史行全部失效
    const relativePath = `${release.id}/${hash}.map`;
    const dir = join(uploadsRoot(), release.id);
    const absolutePath = join(dir, `${hash}.map`);

    const existedBefore = await fileExists(absolutePath);
    await mkdir(dir, { recursive: true });
    await writeFile(absolutePath, buffer);

    // ── ⑤ 写库 ──
    let reused: boolean;
    try {
      await this.prisma.sourcemapFile.create({
        data: {
          releaseId: release.id,
          artifactPath,
          sourcemapPath: relativePath,
          // size_bytes 是 BIGINT，Prisma 要求 bigint 或 number；这里用 bigint 更明确
          sizeBytes: BigInt(buffer.length),
        },
      });
      reused = false;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        // ── ⑥ 失败清理：只删本次新建的文件 ──
        // 如果这个文件是之前某次成功上传留下的（内容相同 → 同一个哈希名），
        // 删掉它会把那条已存在的记录变成悬空 —— 所以必须看 existedBefore。
        if (!existedBefore) {
          await unlink(absolutePath).catch((cleanupErr: unknown) => {
            this.logger.error(
              `清理孤儿文件失败，需人工处理: ${absolutePath} 原因=${String(cleanupErr)}`,
            );
          });
        }
        throw err;
      }

      // (release, artifact_path) 已存在 → 覆盖成这次的内容
      await this.prisma.sourcemapFile.update({
        where: {
          releaseId_artifactPath: { releaseId: release.id, artifactPath },
        },
        data: { sourcemapPath: relativePath, sizeBytes: BigInt(buffer.length) },
      });
      reused = true;
    }

    this.logger.log(
      `Sourcemap 已接收: release=${release.version} path=${artifactPath} ` +
        `size=${buffer.length} reused=${reused} file=${relativePath}`,
    );

    return {
      release_id: release.id,
      artifact_path: artifactPath,
      size_bytes: buffer.length,
      reused,
    };
  }

  /**
   * 校验上传令牌。
   *
   * 三条设计：
   *   · **fail closed** —— 服务端没配 ARGUS_TOKEN 时一律 401，绝不默认放行
   *   · **常量时间比较** —— 先把两边都 sha256 成 32 字节再比，这样长度差异不会
   *     从提前返回里泄漏时间信息（直接比长度会泄漏 token 长度）
   *   · **不写日志** —— 错误信息只说"不正确"，不打印实际收到什么
   */
  private assertToken(token: string | undefined): void {
    const expected = process.env.ARGUS_TOKEN;
    if (expected === undefined || expected === '') {
      throw new UnauthorizedException(
        '服务端未配置 ARGUS_TOKEN，sourcemap 上传接口已禁用（fail closed）',
      );
    }

    const digest = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest();
    const same = timingSafeEqual(digest(token ?? ''), digest(expected));
    if (!same) {
      throw new UnauthorizedException('x-argus-token 不正确');
    }
  }
}

/** 文件是否已存在。只关心"在不在"，不关心大小 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Prisma 的唯一约束冲突（P2002） */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
