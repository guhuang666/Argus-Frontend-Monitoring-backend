/**
 * 小时聚合回填（M5 / B3）。
 *
 *   npm run stats:backfill              # 全量重建
 *   npm run stats:backfill -- --dry-run # 只看会写成什么，一个字节都不落库
 *   npm run stats:backfill -- --project <uuid>  # 只重建某个项目
 *
 * ── 为什么需要回填 ──────────────────────────────────────────────────────
 * `issue_stats_hourly` 是 B2 之后才开始写的。B2 之前已经落库的明细
 * （历史 error_events / affected_users）在那张表里一条记录都没有，
 * 趋势图会显示"这一周之前一片空白"。回填就是拿明细重新算一遍聚合。
 *
 * ── 数据从哪来（唯一的真相）────────────────────────────────────────────
 *   event_count ← count(error_events)  GROUP BY 项目, 问题, 小时(timestamp)
 *   user_count  ← count(affected_users) GROUP BY 项目, 问题, 小时(first_seen)
 *
 * 两张表都要参与，因为它们的"小时"不完全重合：
 *   · 有事件但没新增用户 —— 老用户又踩了一次（绝大多数桶）
 *   · 有新增用户但事件已过期 —— 明细保留 30 天，affected_users 不会跟着删，
 *     所以第 31~∞ 天可能出现"只有用户数、没有事件数"的桶
 * 只用其中一张表重建，另一个数字就会永久偏小。
 *
 * ⚠ 两个"小时"的来源不同，这是刻意的：
 *   · 事件用 timestamp（客户端时钟）= 和 B2 归并时 toHourBucket(claimed.timestamp) 一致
 *   · 用户用 first_seen（服务端时钟）= 就是"这个用户第一次被记录的时刻"
 *   混用会让回填结果和 B2 实时写入的结果对不上，B4 对账立刻炸。
 *
 * ── 幂等性 ─────────────────────────────────────────────────────────────
 * 先 DELETE 再 INSERT，全部在**一个事务**里。跑 1 次和跑 100 次结果完全相同。
 * 为什么不用纯 upsert：只 upsert 的话，明细里已经不存在的小时会留下幽灵行，
 * 那些行的 event_count 永远不会被归零。删了重建没有这个问题。
 * 事务保证数据要么是"全旧"要么是"全新"，不会出现跑到一半的空窗期。
 *
 * ── --dry-run 怎么做到"不落库" ─────────────────────────────────────────
 * 不是另写一套只读 SQL（那样测的是另一段代码，等于没测），而是
 * **把真正的写操作全跑一遍，最后抛一个哨兵异常让事务回滚**。
 * 所以 dry-run 打印的数字，就是真跑一遍会写进去的数字。
 *
 * ── 为什么是 .cjs ───────────────────────────────────────────────────────
 * 同 seed.cjs：Prisma 生成物是 TS，只能用 nest build 之后的 CJS 版本。
 */
const { PrismaClient } = require('../dist/generated/prisma/client')

const prisma = new PrismaClient()

const DRY_RUN = process.argv.includes('--dry-run')

/** --project <uuid> 可选：只重建一个项目（演练 / 修单个项目的数据时很有用） */
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

/** dry-run 用的事务回滚信号。不能和真正的错误混在一起，所以单独定义 */
class DryRunRollback extends Error {}

/**
 * UTC 整点截断的 SQL 写法 —— 必须和 src/grouping/issue-stats.ts 的
 * toHourBucket() 逐位一致（那份是 `Math.floor(ms / 3600000) * 3600000`）。
 *
 * ⚠ 不要换成 date_trunc('hour', ts)：它按**会话时区**截断。
 * 同一批数据在 TimeZone=UTC 和 TimeZone=Asia/Shanghai 下会落进不同的桶，
 * 而"哪个时区"取决于连接串/数据库配置，属于随时会变的隐式输入。
 * extract(epoch from ts) 永远是 UTC 秒数，除以 3600 向下取整再乘回去，
 * 得到的是同一个瞬时值 —— 和时区无关，也和 toHourBucket 数学等价。
 *
 * 用 numeric 而不是 float：epoch 带小数（.512），numeric 是精确十进制，
 * 不会出现 1759999999.512 / 3600 被浮点误差推到整数边界另一边的情况。
 */
const HOUR_SQL = (col) =>
  `to_timestamp((floor(extract(epoch FROM "${col}") / 3600) * 3600)::double precision)`

/** --project 的作用域片段。参数走 $1，不做字符串拼接 */
const scope = projectArg ? ' AND "project_id" = $1::uuid' : ''
const params = projectArg ? [projectArg] : []

const DELETE_SQL = `DELETE FROM "issue_stats_hourly" WHERE true${scope}`

/**
 * ① 事件数：明细里"每个 项目×问题×小时 有几条"。
 * 只算 group_id IS NOT NULL 的 —— 还没归并（未分配问题）的事件挂不到任何问题上，
 * 硬塞进聚合会让 sum(event_count) 大于"能归属到问题的明细条数"。
 */
const INSERT_EVENT_COUNTS_SQL = `
INSERT INTO "issue_stats_hourly" ("project_id", "group_id", "hour", "event_count", "user_count")
SELECT
  "project_id",
  "group_id",
  ${HOUR_SQL('timestamp')},
  count(*)::int,
  0
FROM "error_events"
WHERE "group_id" IS NOT NULL${scope}
GROUP BY 1, 2, 3
ON CONFLICT ("project_id", "group_id", "hour") DO UPDATE
  SET "event_count" = EXCLUDED."event_count"
`

/**
 * ② 用户数：去重表里"每个 项目×问题×小时 新增了几张新面孔"。
 * ON CONFLICT 只更新 user_count，不动 event_count —— 这样 ①② 的先后顺序
 * 不影响结果，同一个桶被两条 INSERT 各写一半也能拼成完整的一行。
 */
const INSERT_USER_COUNTS_SQL = `
INSERT INTO "issue_stats_hourly" ("project_id", "group_id", "hour", "event_count", "user_count")
SELECT
  "project_id",
  "group_id",
  ${HOUR_SQL('first_seen')},
  0,
  count(*)::int
FROM "affected_users"
WHERE true${scope}
GROUP BY 1, 2, 3
ON CONFLICT ("project_id", "group_id", "hour") DO UPDATE
  SET "user_count" = EXCLUDED."user_count"
`

/** 回填完（或回滚前）的体检：聚合总数 vs 明细总数 */
const SUMMARY_SQL = `
SELECT
  (SELECT count(*)::int FROM "issue_stats_hourly" WHERE true${scope})            AS stat_rows,
  (SELECT coalesce(sum("event_count"), 0)::int FROM "issue_stats_hourly" WHERE true${scope}) AS stat_events,
  (SELECT coalesce(sum("user_count"), 0)::int FROM "issue_stats_hourly" WHERE true${scope})  AS stat_users,
  (SELECT min("hour") FROM "issue_stats_hourly" WHERE true${scope})              AS min_hour,
  (SELECT max("hour") FROM "issue_stats_hourly" WHERE true${scope})              AS max_hour,
  (SELECT count(*)::int FROM "error_events" WHERE "group_id" IS NOT NULL${scope}) AS detail_events,
  (SELECT count(*)::int FROM "affected_users" WHERE true${scope})                 AS detail_users
`

const fmt = (d) => (d instanceof Date ? d.toISOString() : String(d))

async function main() {
  const startedAt = Date.now()
  const written = { deleted: 0, events: 0, users: 0 }
  let summary = null

  console.log(
    `回填范围：${projectArg ? `项目 ${projectArg}` : '全部项目'}` +
      `${DRY_RUN ? '（dry-run：跑完会回滚）' : ''}`,
  )

  try {
    // 超时放宽到 2 分钟：交互式事务默认只有 5s，数据量涨上来就会莫名失败
    await prisma.$transaction(
      async (tx) => {
        written.deleted = await tx.$executeRawUnsafe(DELETE_SQL, ...params)
        written.events = await tx.$executeRawUnsafe(
          INSERT_EVENT_COUNTS_SQL,
          ...params,
        )
        written.users = await tx.$executeRawUnsafe(
          INSERT_USER_COUNTS_SQL,
          ...params,
        )

        // dry-run 也想看到"写完之后长什么样"，所以在事务内先读一遍再回滚
        const rows = await tx.$queryRawUnsafe(SUMMARY_SQL, ...params)
        summary = rows[0]

        if (DRY_RUN) throw new DryRunRollback()
      },
      { timeout: 120_000, maxWait: 10_000 },
    )
  } catch (err) {
    // 只有我们自己抛的哨兵能被吞掉；真错误要原样冒出去
    if (!(err instanceof DryRunRollback)) throw err
  }

  const ms = Date.now() - startedAt
  const eventsOk = summary.stat_events === summary.detail_events
  const usersOk = summary.stat_users === summary.detail_users

  console.log(
    [
      '',
      `  ${DRY_RUN ? '将删除' : '已删除'}   ${written.deleted} 行旧聚合`,
      `  ${DRY_RUN ? '将写入' : '已写入'}   ${written.events} 行事件计数（来自 error_events）`,
      `  ${DRY_RUN ? '将写入' : '已写入'}   ${written.users} 行用户计数（来自 affected_users，可能落入已有桶）`,
      '',
      `  聚合表   ${summary.stat_rows} 行，时间范围 ${fmt(summary.min_hour)} ~ ${fmt(summary.max_hour)}`,
      `  事件数   sum(event_count) = ${summary.stat_events}  ｜  明细 ${summary.detail_events}  ${eventsOk ? '✓' : '✗'}`,
      `  用户数   sum(user_count)  = ${summary.stat_users}  ｜  明细 ${summary.detail_users}  ${usersOk ? '✓' : '✗'}`,
      '',
      `  耗时 ${ms}ms${DRY_RUN ? '（已回滚，库里没有任何变化）' : ''}`,
    ].join('\n'),
  )

  if (!eventsOk || !usersOk) {
    console.error(
      '\n✗ 总数对不上。常见原因：明细里有 group_id 指向已删问题（不该发生，FK 会拦住），' +
        '或者期间的 B2 实时写入用了另一个小时截断规则。逐组核对：npm run stats:reconcile',
    )
    process.exitCode = 1
    return
  }

  if (!DRY_RUN) {
    console.log('  逐组核对请跑：npm run stats:reconcile')
  }
}

main()
  .catch((err) => {
    console.error('回填失败：', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
