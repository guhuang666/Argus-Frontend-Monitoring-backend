/**
 * 新建项目 + 一对密钥（M4-S2）。
 *
 *   npm run project:new -- "我的商城"
 *
 * 输出 JSON：{ projectId, publicKey, secretKey }
 *   publicKey → 能放进浏览器（SDK 初始化、HTML、构建产物里都行）
 *   secretKey → 只能进 CI 变量 / 本地 .env，用来上传 sourcemap
 *
 * ── 为什么密钥在脚本里生成，而不是在 API 里 ──────────────────────────────
 * 现在还没有登录态（S4 才有 JWT），任何"创建项目 + 发密钥"的 HTTP 接口
 * 都等于对外开放。先用本地脚本：谁能连数据库、谁能跑这个脚本，边界清楚。
 * S4 起来会有一个带鉴权的同名接口，这个脚本保留给初始化和演练。
 *
 * ── 为什么是 .cjs ───────────────────────────────────────────────────────
 * 同 seed.cjs：Prisma 生成物是 TS，只能用 nest build 之后的 CJS 版本。
 */
const { PrismaClient } = require('../dist/generated/prisma/client')
const { generatePublicKey, generateSecretKey, hashSecret } = require('../dist/src/common/keys')

const prisma = new PrismaClient()

const ORG_SLUG = process.env.ARGUS_ORG_SLUG ?? 'argus'

async function main() {
  const name = process.argv[2]?.trim()
  if (!name) {
    console.error('用法：npm run project:new -- "<项目名>"')
    process.exitCode = 1
    return
  }

  const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG } })
  if (org === null) {
    console.error(`组织不存在: ${ORG_SLUG}（先跑 npm run seed）`)
    process.exitCode = 1
    return
  }

  // 同一组织下项目重名会让看板切换器出现两个一样的条目 —— 直接拒绝
  const clash = await prisma.project.findFirst({ where: { orgId: org.id, name } })
  if (clash !== null) {
    console.error(`项目已存在: ${name}（id=${clash.id}）。换个名字，或直接用它现有的公钥。`)
    process.exitCode = 1
    return
  }

  const publicKey = generatePublicKey()
  const secretKey = generateSecretKey()

  // 嵌套 create：项目和密钥要么一起成功，要么一起不成功。
  // 中间失败留下一个"没有密钥的项目"会让后面所有上报都是 401，极难倒推原因。
  const project = await prisma.project.create({
    data: {
      orgId: org.id,
      name,
      keys: {
        create: [{ publicKey, secretKeyHash: hashSecret(secretKey), label: 'initial' }],
      },
    },
    select: { id: true, name: true, platform: true, createdAt: true },
  })

  console.log(
    JSON.stringify(
      {
        projectId: project.id,
        name: project.name,
        platform: project.platform,
        publicKey,
        secretKey,
        savedAt: project.createdAt,
        hint: {
          上报: `initArgus({ key: '${publicKey}', ... })`,
          上传: `npm run release -- --project ${project.id} --secret ${secretKey}`,
        },
      },
      null,
      2,
    ),
  )
}

main()
  .catch((err) => {
    console.error('新建项目失败：', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
