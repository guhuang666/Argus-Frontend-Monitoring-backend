/**
 * 种子数据：建一个默认组织 + 项目 + 一把上报密钥，并打印常用 id。
 *
 * ── 为什么是 .cjs 而不是 .ts ──────────────────────────────────────────────
 * Prisma 的 `prisma-client` 生成器产出的是 **TypeScript**（generated/prisma/*.ts），
 * 而它内部的 import 带了 `.js` 后缀（指向尚未编译的 .ts）—— ts-node 直接加载会
 * MODULE_NOT_FOUND（jest 里 mock 掉它也是这个原因）。
 * 所以这里改用 `nest build` 产出的 CJS 版本：dist/generated/prisma/client.js。
 *
 * 代价：跑之前要先 `npm run build`。npm script `seed` 已经把它串好。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 按 org.slug / 项目名查，存在就复用，反复跑不会产生重复数据。
 *
 * ── 关于私钥只打印一次（M4-S2）──────────────────────────────────────────
 * 库里只存 sha256，**第二次跑这个脚本就再也拿不到明文私钥了** —— 这是设计，
 * 不是 bug。需要新私钥时的正确做法是新建一把（S2 之后有 `npm run project:new`），
 * 而不是"把旧的读出来"。
 */
const { PrismaClient } = require('../dist/generated/prisma/client')
const { generatePublicKey, generateSecretKey, hashSecret } = require('../dist/src/common/keys')

const prisma = new PrismaClient()

const ORG_SLUG = 'argus'
const ORG_NAME = 'Argus'
const PROJECT_NAME = '默认项目'

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: { name: ORG_NAME, slug: ORG_SLUG },
  })

  const existing = await prisma.project.findFirst({
    where: { orgId: org.id, name: PROJECT_NAME },
  })

  const project =
    existing ??
    (await prisma.project.create({
      data: { orgId: org.id, name: PROJECT_NAME },
    }))

  // 已有有效密钥就不动它：重跑 seed 不该让线上 SDK 配置失效
  const activeKey = await prisma.projectKey.findFirst({
    where: { projectId: project.id, revokedAt: null },
    orderBy: { createdAt: 'asc' },
  })

  let created = null
  if (activeKey === null) {
    const publicKey = generatePublicKey()
    const secretKey = generateSecretKey()
    await prisma.projectKey.create({
      data: {
        projectId: project.id,
        publicKey,
        secretKeyHash: hashSecret(secretKey),
        label: 'seed',
      },
    })
    created = { publicKey, secretKey }
  }

  console.log(
    JSON.stringify(
      {
        orgId: org.id,
        projectId: project.id,
        reused: existing !== null,
        publicKey: created?.publicKey ?? activeKey.publicKey,
        // null 表示这把私钥早就生成过、明文已不可得
        secretKey: created?.secretKey ?? null,
        secretKeyHint:
          created === null ? '私钥已存在且无法再读出；需要新私钥请新建一把密钥' : '请立即保存，之后不再可读',
      },
      null,
      2,
    ),
  )
}

main()
  .catch((err) => {
    console.error('seed 失败：', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
