/**
 * 小时聚合对账（M5 / B4）。
 *
 *   npm run stats:reconcile
 *   npm run stats:reconcile -- --project <uuid>
 *
 * 退出码：全过 0，任何一项对不上 1（能直接塞进 CI / pre-deploy）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * `issue_stats_hourly` 是一份**冗余**数据：同样的信息在 error_events /
 * affected_users / error_groups 里都有。冗余的好处是查询快，代价是**可能不同步**——
 * 事务漏了一半、小时截断规则改过、回填脚本算错……任何一处出问题，
 * 看板上的数字就开始骗人，而且骗得很安静（没人报错，只是曲线不对）。
 * 这个脚本把"同一件事的两种数法"摆在一起比。
 *
 * ── 五条恒等式 ─────────────────────────────────────────────────────────
 *   ① sum(event_count)  == count(error_events WHERE group_id IS NOT NULL)
 *   ② sum(user_count)   == count(affected_users)
 *   ③ 逐组 sum(event_count) == error_groups.times_seen == 该组明细条数
 *   ④ 逐组 sum(user_count)  == error_groups.users_seen
 *   ⑤ hour 必须落在 UTC 整点上（截断规则有没有被改坏的直接证据）
 * 外加一条结构检查：
 *   ⑥ 聚合行的 project_id 必须和它所属问题的 project_id 一致
 *      （外键只约束 group_id 存在，拦不住"写错项目"这种 bug）
 *
 * ①② 是全局守恒，③④ 是逐组守恒。两组都必要：全局相等而逐组不等，
 * 说明错误在组之间串了（比如 group_id 写错一个），全局检查发现不了。
 *
 * ── 为什么不写进单测 ───────────────────────────────────────────────────
 * 这些断言针对的是**数据**，不是代码。单测跑在空库上永远是 100% 通过。
 * 它是运维脚本：上线后 / 回填后 / 改了归并逻辑后手动跑一次。
 *
 * ── 为什么是 .cjs ───────────────────────────────────────────────────────
 * 同 seed.cjs：Prisma 生成物是 TS，只能用 nest build 之后的 CJS 版本。
 */
const { PrismaClient } = require('../dist/generated/prisma/client')

const prisma = new PrismaClient()

const projectArg = (() => {
  const i = process.argv.indexOf('--project')
  if (i === -1) return null
  const raw = process.argv[i + 1]
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw ?? '')) {
    console.error(`--project 后面要跟一个 uuid，收到的是: ${raw ?? '(空)'}`)
    process.exit(1)
  }
  return raw
})()

/**
 * --project 的作用域片段。
 * 显式传入列名，因为有的查询给表起了别名（g），有的没起 —— 依赖"PG 自己猜"
 * 会在加字段之后突然变成 ambiguous column。
 */
const scopeOf = (col) => (projectArg ? ` AND ${col} = $1::uuid` : '')
const scope = scopeOf('"project_id"')
const params = projectArg ? [projectArg] : []

/** 和回填脚本、toHourBucket() 共用的 UTC 整点表达式 */
const HOUR_OF = (col) =>
  `to_timestamp((floor(extract(epoch FROM "${col}") / 3600) * 3600)::double precision)`

/**
 * ① + ②：全局守恒。
 * 用 ::int 而不是 ::bigint —— 演示规模下不可能到 21 亿，
 * 而 bigint 会被 Prisma 映射成 BigInt，比较和打印都多一层坑。
 */
const GLOBAL_SQL = `
SELECT
  (SELECT count(*)::int FROM "issue_stats_hourly" WHERE true${scope})                       AS stat_rows,
  (SELECT coalesce(sum("event_count"), 0)::int FROM "issue_stats_hourly" WHERE true${scope}) AS stat_events,
  (SELECT coalesce(sum("user_count"), 0)::int FROM "issue_stats_hourly" WHERE true${scope})  AS stat_users,
  (SELECT count(*)::int FROM "error_events"
     WHERE "group_id" IS NOT NULL${scope})                                                 AS detail_events,
  (SELECT count(*)::int FROM "affected_users" WHERE true${scope})                           AS detail_users
`

/**
 * ③ + ④：逐组守恒，外加"该组明细条数"做第三方见证。
 * times_seen 是归并时 increment 出来的，理论上等于明细条数；
 * 三者两两相等才是最稳的（任意一个单独都可能被同一个 bug 改坏）。
 *
 * LEFT JOIN 聚合视图 + coalesce：一个组如果一条聚合行都没有，
 * 它的 stat_events 是 NULL，而 times_seen 是 0 或正数 —— 必须报出来。
 * 这正是"B2 上线后新发生的事件写了、历史没回填"的典型症状。
 */
const PER_GROUP_SQL = `
SELECT
  g."id"::text                    AS group_id,
  g."project_id"::text            AS project_id,
  g."times_seen"::int             AS times_seen,
  g."users_seen"::int             AS users_seen,
  coalesce(s.events, 0)::int      AS stat_events,
  coalesce(s.users, 0)::int       AS stat_users,
  (SELECT count(*)::int FROM "error_events" e WHERE e."group_id" = g."id") AS detail_events
FROM "error_groups" g
LEFT JOIN (
  SELECT "group_id", sum("event_count") AS events, sum("user_count") AS users
  FROM "issue_stats_hourly"
  GROUP BY "group_id"
) s ON s."group_id" = g."id"
WHERE true${scopeOf('g."project_id"')}
  AND (
    g."times_seen" <> coalesce(s.events, 0)
    OR g."users_seen" <> coalesce(s.users, 0)
    OR g."times_seen" <> (SELECT count(*) FROM "error_events" e WHERE e."group_id" = g."id")
  )
ORDER BY g."times_seen" DESC
LIMIT 50
`

/** ⑤：有没有哪个 hour 不是整点 */
const NOT_ALIGNED_SQL = `
SELECT count(*)::int AS n
FROM "issue_stats_hourly"
WHERE "hour" <> ${HOUR_OF('hour')}${scope}
`

/** ⑥：聚合写到了别的项目名下 */
const CROSS_PROJECT_SQL = `
SELECT s."project_id"::text AS stat_project_id,
       s."group_id"::text   AS group_id,
       g."project_id"::text AS real_project_id
FROM "issue_stats_hourly" s
JOIN "error_groups" g ON g."id" = s."group_id"
WHERE s."project_id" <> g."project_id"
LIMIT 20
`

async function main() {
  const startedAt = Date.now()
  console.log(
    `对账范围：${projectArg ? `项目 ${projectArg}` : '全部项目'}\n`,
  )

  const [global] = await prisma.$queryRawUnsafe(GLOBAL_SQL, ...params)
  const badGroups = await prisma.$queryRawUnsafe(PER_GROUP_SQL, ...params)
  const [notAligned] = await prisma.$queryRawUnsafe(NOT_ALIGNED_SQL, ...params)
  const crossProject = await prisma.$queryRawUnsafe(CROSS_PROJECT_SQL, ...params)

  /** 所有检查项集中在这里，失败项统一收尾 —— 加一条新恒等式只需要 push 一行 */
  const checks = [
    {
      name: 'sum(event_count) == 明细事件条数',
      expected: global.detail_events,
      actual: global.stat_events,
      ok: global.stat_events === global.detail_events,
    },
    {
      name: 'sum(user_count) == 去重用户条数',
      expected: global.detail_users,
      actual: global.stat_users,
      ok: global.stat_users === global.detail_users,
    },
    {
      name: '逐组守恒（times_seen / users_seen / 明细条数）',
      expected: '每个组都相等',
      actual: badGroups.length === 0 ? '全部相等' : `${badGroups.length} 个组不等`,
      ok: badGroups.length === 0,
    },
    {
      name: 'hour 全部是 UTC 整点',
      expected: 0,
      actual: notAligned.n,
      ok: notAligned.n === 0,
    },
    {
      name: '聚合行与所属问题同项目',
      expected: 0,
      actual: crossProject.length,
      ok: crossProject.length === 0,
    },
  ]

  for (const c of checks) {
    console.log(
      `  ${c.ok ? '✓' : '✗'} ${c.name}\n` +
        `      期望 ${c.expected}  ｜  实际 ${c.actual}`,
    )
  }

  if (badGroups.length > 0) {
    console.log('\n  逐组差异（最多 50 条）：')
    console.table(badGroups)
  }
  if (crossProject.length > 0) {
    console.log('\n  项目串了：')
    console.table(crossProject)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(
    `\n  聚合表 ${global.stat_rows} 行 ｜ ${checks.length} 项检查：` +
      `${checks.length - failed.length} 通过，${failed.length} 失败 ｜ ${Date.now() - startedAt}ms`,
  )

  if (failed.length > 0) {
    console.error(
      '\n✗ 对账不通过。先别信趋势图上的任何数字。\n' +
        '  修复顺序：① npm run stats:backfill（多半一步就解决）\n' +
        '           ② 还在不对 → 逐组看差异表，那是归并逻辑写错了，不是聚合的问题',
    )
    process.exitCode = 1
    return
  }

  console.log('✓ 全部通过')
}

main()
  .catch((err) => {
    console.error('对账失败：', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
