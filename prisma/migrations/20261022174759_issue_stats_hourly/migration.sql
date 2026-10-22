-- M5 / B1：问题的小时聚合表
--
-- 用途：趋势图 / 排行 / 概览的唯一数据源。明细（error_events）只保留 30 天，
-- 而跨版本对比必须能看更长的区间 —— 明细过期后，本表就是趋势的全部依据（TC-12）。
--
-- 主键 (project_id, group_id, hour)：
--   · project_id 在最左，满足 TC-08「每次查询都带 projectId」
--   · hour 是 **UTC 整点**，由应用层 toHourBucket() 截断。
--     ⚠ 不要用 date_trunc() 重建整点：它按会话时区截断，换个 TimeZone 结果就变，
--     会把同一条明细算进两个桶，对账（B4）立刻发现 sum(event_count) ≠ 明细条数。
--
-- 外键 ON DELETE CASCADE：删问题时连带删掉它的聚合行。没有这条约束的话，
-- 删过的项目会永远留下指向已消失问题的聚合，sum(event_count) 只增不减。

-- CreateTable
CREATE TABLE "issue_stats_hourly" (
    "project_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "hour" TIMESTAMPTZ NOT NULL,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "user_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "issue_stats_hourly_pkey" PRIMARY KEY ("project_id","group_id","hour")
);

-- CreateIndex
CREATE INDEX "issue_stats_hourly_project_id_hour_idx" ON "issue_stats_hourly"("project_id", "hour");

-- AddForeignKey
ALTER TABLE "issue_stats_hourly" ADD CONSTRAINT "issue_stats_hourly_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
