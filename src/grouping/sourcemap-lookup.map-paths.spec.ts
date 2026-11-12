import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { SourcemapLookupService } from './sourcemap-lookup.service';

/**
 * mapPathsFor 的最小单测（就 1 条用例）。
 *
 * 跑它：
 *   npx jest --runInBand src/grouping/sourcemap-lookup.map-paths
 *
 * ── 这个函数干什么 ──────────────────────────────────────────────────────
 *   (项目, 版本) → 一张「产物路径 → map 文件路径」的表
 * 比如「web@1.0.0 的 /assets/index.js 那份 map 存在 release-1/a1b2.map」。
 *
 * ── 为什么测试里不用真数据库 ────────────────────────────────────────────
 * 它的 db 是**参数**，所以测试可以自己造一个假对象塞进去：
 * 只实现真正会被调到的两个方法就行，不需要启动 PG、不需要 migration。
 */
jest.mock('../../generated/prisma/client', () => ({
  // prisma.service.ts 里是 `class PrismaService extends PrismaClient`，
  // 这个类必须存在，否则加载时直接 "Class extends value undefined"
  PrismaClient: class PrismaClient {},
}));

/** 被测方法的签名（它是 private，测试里用窄类型断言取出来） */
type MapPathsFor = (
  db: Prisma.TransactionClient,
  projectId: string,
  release: string,
) => Promise<Map<string, string>>;

function buildService(): SourcemapLookupService {
  // 构造函数里的 prisma 在 mapPathsFor 里用不到（db 是参数），给个空对象即可
  return new SourcemapLookupService({} as unknown as PrismaService);
}

/**
 * 取出 private 方法。
 *
 * 为什么不在生产代码里把它改成 public：那只是为了让测试方便，
 * 却把类的 API 变宽了。这里用类型断言，签名仍然是完整的（参数写错 TS 会报）。
 * holder 和 service 是同一个对象，所以方法里的 this 就是 service。
 */
function mapPathsForOf(service: SourcemapLookupService): MapPathsFor {
  const holder = service as unknown as { mapPathsFor: MapPathsFor };
  return (db, projectId, release) => holder.mapPathsFor(db, projectId, release);
}

describe('mapPathsFor', () => {
  it('把一个产物文件读成「产物路径 → map 路径」', async () => {
    // ① 准备：一个假数据库。
    //    它只做一件事——按 mapPathsFor 会问的两个问题回答：
    //      release.findUnique    → 这个版本存在吗？存在，id 是 release-1
    //      sourcemapFile.findMany → 这个版本下有哪些文件？有一个
    const db = {
      release: {
        findUnique: () => Promise.resolve({ id: 'release-1' }),
      },
      sourcemapFile: {
        findMany: () =>
          Promise.resolve([
            {
              artifactPath: '/assets/index.js',
              sourcemapPath: 'release-1/a1b2.map',
            },
          ]),
      },
    } as unknown as Prisma.TransactionClient;

    // ② 执行
    const mapPathsFor = mapPathsForOf(buildService());
    const result = await mapPathsFor(db, 'proj-1', 'web@1.0.0');

    // ③ 断言
    expect(result.get('/assets/index.js')).toBe('release-1/a1b2.map');
  });
});
