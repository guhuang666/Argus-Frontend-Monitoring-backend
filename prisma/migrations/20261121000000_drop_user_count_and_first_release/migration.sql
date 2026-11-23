-- 删掉两列冗余字段，并给新查询补一条索引。
--
-- 这份迁移是手写的：改 schema 时没有可连的库，所以没走 `prisma migrate dev`。
-- 有库之后直接 `npx prisma migrate deploy` 即可，效果与自动生成的一致。
--
-- 背景：
--   · issue_stats_hourly.user_count —— 批次归并时"新增用户"是整批一个数，
--     拆不到小时，只能硬塞给某个桶；且它与 event_count 用的时钟不同。
--     看板改为直接查 affected_users.first_seen（stats.service 的 byUsers）。
--   · affected_users.first_release —— 只写不读的归因字段，没人消费。

ALTER TABLE "issue_stats_hourly" DROP COLUMN "user_count";

ALTER TABLE "affected_users" DROP COLUMN "first_release";

-- 概览页"新增受影响用户"榜：按 projectId + firstSeen 窗口聚合。
-- 主键是 (project_id, group_id, user_key)，用不上 first_seen，所以单独建索引。
CREATE INDEX "affected_users_project_id_first_seen_idx"
    ON "affected_users" ("project_id", "first_seen");
