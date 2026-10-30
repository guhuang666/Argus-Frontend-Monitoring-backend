import type { PrismaService } from '../../src/prisma/prisma.service';
import { generatePublicKey, generateSecretKey, hashSecret } from '../../src/common/keys';

/**
 * e2e 的数据准备（fixtures）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 一条好的 e2e 用例，90% 的代码不该花在"造一个能用的项目"上 ——
 * 那不是被测对象，只是背景。把这四步（org → project → 公钥 → 私钥哈希）
 * 收成 createProject()，用例里就只剩一行，读的人能直接看到"这条用例在验什么"。
 *
 * ── 为什么每个 suite 开头要 resetDb() ────────────────────────────────────
 * e2e 最常见的假失败不是代码错了，而是**上一轮的数据还在**：
 *   · 第二次跑：org 的 slug 撞唯一约束 → 500，看起来像接口坏了
 *   · 只跑一个文件：它依赖另一个文件先造好的数据 → 挂
 *   · 断言 count：上一轮遗留的行让"应该是 1"变成"是 4"
 * 所以策略选最简单的一种：每个 suite（或每条用例）开头清空所有业务表，
 * 保留表结构与 _prisma_migrations（那两样是 schema 的一部分，不是数据）。
 */

/**
 * 全部业务表。
 *
 * 顺序不重要 —— CASCADE 会处理外键依赖。**故意不包含 _prisma_migrations**：
 * 清掉它等于抹掉迁移历史，之后 `prisma migrate deploy` 会因为"表已存在"而失败。
 */
const BUSINESS_TABLES = [
  'alert_events',
  'alert_rules',
  'sourcemap_files',
  'releases',
  'issue_stats_hourly',
  'affected_users',
  'error_events',
  'error_groups',
  'sessions',
  'performance_metrics',
  'project_keys',
  'projects',
  'users',
  'organizations',
] as const;

/** 清空所有业务数据，保留表结构与迁移历史。 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  const list = BUSINESS_TABLES.map((table) => `"${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

/** 一个可以直接拿去用的测试项目：一把公钥 + 一把（未哈希的）私钥。 */
export interface TestProject {
  orgId: string;
  projectId: string;
  projectName: string;
  /** 上报用：放进 `X-Argus-Key` 请求头 */
  publicKey: string;
  /** Sourcemap 上传用：放进 `Authorization: Bearer ...`（库里只有它的 sha256） */
  secretKey: string;
}

/**
 * 造一个带钥匙的项目。
 *
 * slug / name 带随机后缀：即使某次忘了 resetDb，也不会撞 (orgId, name) 与
 * organization.slug 的唯一约束 —— 让"忘了清理"表现为数据变多，而不是神秘 500。
 */
export async function createProject(
  prisma: PrismaService,
  options: { name?: string } = {},
): Promise<TestProject> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const org = await prisma.organization.create({
    data: { name: `E2E 组织 ${suffix}`, slug: `e2e-${suffix}` },
  });

  const project = await prisma.project.create({
    data: { orgId: org.id, name: options.name ?? 'E2E 项目' },
  });

  const publicKey = generatePublicKey();
  const secretKey = generateSecretKey();

  await prisma.projectKey.create({
    data: {
      projectId: project.id,
      publicKey,
      // 库里只存哈希：私钥原文只在创建时返回给调用方（这里就是我们）
      secretKeyHash: hashSecret(secretKey),
    },
  });

  return {
    orgId: org.id,
    projectId: project.id,
    projectName: project.name,
    publicKey,
    secretKey,
  };
}
