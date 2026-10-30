import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { SourcemapLookupService } from './sourcemap-lookup.service';

/**
 * 成功符号化的一条用例（就 1 条）。
 *
 * 跑它：
 *   npx jest --runInBand src/grouping/sourcemap-lookup.symbolicate
 *
 * ── 这条用例覆盖的正是项目里那个内联箭头 ────────────────────────────────
 *   (artifactPath) => {
 *     const mapPath = mapPathByArtifact.get(artifactPath);
 *     return mapPath === undefined ? null : this.loadMap(mapPath);
 *   }
 * 也就是说它同时踩到三样东西：
 *   ① 假数据库（提供「产物路径 → map 文件路径」这张表）
 *   ② 真磁盘（loadMap 真的 readFileSync + 解析）
 *   ③ 真 sourcemap（一张手写的最小 map）
 */
jest.mock('../../generated/prisma/client', () => ({
  // prisma.service.ts 里是 `class PrismaService extends PrismaClient`
  PrismaClient: class PrismaClient {},
}));

/**
 * 一张最小的 sourcemap。
 *
 * `mappings: 'AAAAA'` 是 VLQ 编码，5 个字段依次是：
 *   生成列 0 → sources[0] → 源码第 1 行 → 源码第 1 列 → names[0]
 * 也就是："产物第 1 行第 0 列，对应 src/app.ts 第 1 行第 1 列，函数叫 render"。
 */
const MAP_JSON = {
  version: 3,
  sources: ['src/app.ts'],
  sourcesContent: ['const a = 1;\nrender();'],
  names: ['render'],
  mappings: 'AAAAA',
};

/** map 文件在 uploads 目录里的相对路径（库里 sourcemap_path 存的就是它） */
const MAP_RELATIVE_PATH = 'release-1.map';

/** 压缩后的帧：浏览器说"出在 index.js 第 1 行第 1 列" */
const FRAMES = [
  {
    file: 'https://app.example.com/assets/index.js',
    fn: 'r',
    line: 1,
    col: 1,
  },
];

let uploadsDir: string;

beforeAll(() => {
  // loadMap 会真的读盘，所以这里造一个临时目录放 map，
  // 并把 UPLOADS_DIR 指过去 —— 不会污染项目里真实的 uploads/
  uploadsDir = mkdtempSync(join(tmpdir(), 'argus-symbolicate-'));
  process.env.UPLOADS_DIR = uploadsDir;
  writeFileSync(
    join(uploadsDir, MAP_RELATIVE_PATH),
    JSON.stringify(MAP_JSON),
    'utf8',
  );
});

afterAll(() => {
  delete process.env.UPLOADS_DIR;
  rmSync(uploadsDir, { recursive: true, force: true });
});

describe('SourcemapLookupService.symbolicate', () => {
  it('查得到 map 时，把压缩位置还原成源码位置', async () => {
    // 假数据库：这个版本存在，且它的 /assets/index.js 有一份 map
    const db = {
      release: {
        findUnique: () => Promise.resolve({ id: 'release-1' }),
      },
      sourcemapFile: {
        findMany: () =>
          Promise.resolve([
            {
              artifactPath: '/assets/index.js',
              sourcemapPath: MAP_RELATIVE_PATH,
            },
          ]),
      },
    } as unknown as Prisma.TransactionClient;

    const service = new SourcemapLookupService({} as unknown as PrismaService);
    const result = await service.symbolicate(
      db,
      'proj-1',
      'web@1.0.0',
      FRAMES,
    );

    expect(result.frames[0]).toMatchObject({
      // 压缩位置原样保留（界面要并排显示）
      artifactPath: '/assets/index.js',
      // 还原结果：来自手写 map 的那 5 个字段
      resolved: true,
      source: 'src/app.ts',
      sourceLine: 1,
      sourceCol: 1,
      name: 'render',
    });

    // 分母（有文件）× 分子（还原成功）都对上，才允许走 v2 指纹
    expect(result.withFileCount).toBe(1);
    expect(result.resolvedCount).toBe(1);
    expect(result.allResolved).toBe(true);
  });
});
