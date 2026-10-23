/**
 * 问题环境回填（M5 / FR-8.3）
 *
 *   node scripts/env-backfill.cjs              # 全量回填
 *   node scripts/env-backfill.cjs --dry-run    # 只看会影响多少行，不落库
 *
 * ── 为什么需要回填 ──────────────────────────────────────────────────────
 * `error_groups.last_environment` 是这一版才加的列。在此之前归并出来的问题
 * 这一列全是 NULL，于是"按环境筛选"对历史数据完全失效 —— 用户会看到
 * "我刚发的问题明明是生产环境，筛 production 却找不到"。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────────────────
 * 取每个问题**最新一条**事件的 environment（按事件时间 timestamp 倒序）。
 * 这与实时的写法一致：B2 之后归并时写的就是"最近一次"的环境。
 *
 * ── 为什么用 `IS DISTINCT FROM` ─────────────────────────────────────────
 * 普通 `<>` 遇到 NULL 会返回 NULL（既不是真也不是假），
 * 于是 last_environment 还是 NULL 的那些行永远不会被更新。
 * `IS DISTINCT FROM` 把 NULL 当成一个普通值来比，才是我们要的语义。
 *
 * ── 幂等性 ──────────────────────────────────────────────────────────────
 * 只更新"值真的不一样"的行，跑 1 次和跑 100 次结果相同。
 * dry-run 用的是"把更新跑一遍再回滚"，所以打印的数字就是真跑的影响行数。
 */
const { PrismaClient } = require('../dist/generated/prisma/client')

const prisma = new PrismaClient()

const DRY_RUN = process.argv.includes('--dry-run')

/** dry-run 的回滚信号：必须和真正的错误区分开，否则会把失败当成功 */
class Rollback extends Error {}

async function main() {
  let affected = 0

  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(`
        WITH latest AS (
          SELECT DISTINCT ON (group_id) group_id, environment
            FROM error_events
           WHERE group_id IS NOT NULL
             AND environment IS NOT NULL
           ORDER BY group_id, "timestamp" DESC
        )
        UPDATE error_groups g
           SET last_environment = latest.environment
          FROM latest
         WHERE g.id = latest.group_id
           AND g.last_environment IS DISTINCT FROM latest.environment
        RETURNING g.id
      `)

      affected = rows.length
      if (DRY_RUN) throw new Rollback('dry-run')
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  const [{ total, filled }] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS total,
           COUNT(last_environment)::int AS filled
      FROM error_groups
  `)

  console.log('')
  console.log(DRY_RUN ? '回填范围：全部问题（dry-run：已回滚）' : '回填范围：全部问题')
  console.log(`  ${DRY_RUN ? '将更新' : '已更新'}   ${affected} 行`)
  console.log(`  error_groups 共 ${total} 行，其中 ${filled} 行有环境（${total === 0 ? 0 : Math.round((filled / total) * 100)}%）`)
  console.log('')
  console.log('  说明：没带 environment 的历史事件无法回填，那部分问题会保持 NULL，')
  console.log('        按环境筛选时它们不会出现在任何环境里（这是正确行为，不是丢失）。')
}

main()
  .catch((error) => {
    console.error('回填失败：', error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
