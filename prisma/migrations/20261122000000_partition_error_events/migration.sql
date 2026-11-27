-- error_events: 普通表 → 按天 RANGE 分区表
-- Prisma 会把整个文件包在一个事务里执行，失败整体回滚。

-- ① 旧表让位；索引名在 schema 内全局唯一，必须一并腾出
ALTER TABLE "error_events" RENAME TO "error_events_legacy";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'error_events_pkey') THEN
    ALTER INDEX "error_events_pkey" RENAME TO "error_events_legacy_pkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'error_events_project_id_timestamp_idx') THEN
    ALTER INDEX "error_events_project_id_timestamp_idx"
      RENAME TO "error_events_legacy_project_ts_idx";
  END IF;
END $$;

-- ② 新表：只抄列定义与默认值。
-- 不能 INCLUDING ALL —— 旧主键 (event_id) 不含分区键，PG 会拒绝
CREATE TABLE "error_events" (
  LIKE "error_events_legacy" INCLUDING DEFAULTS
) PARTITION BY RANGE ("timestamp");

-- ③ 建分区：覆盖历史每一天 + 未来 7 天，上限 90 天防脏数据把分区数炸开
DO $$
DECLARE
  lo date;
  hi date;
  d  date;
BEGIN
  SELECT COALESCE(min("timestamp") AT TIME ZONE 'UTC', current_date)::date,
         COALESCE(max("timestamp") AT TIME ZONE 'UTC', current_date)::date
    INTO lo, hi
    FROM "error_events_legacy";

  hi := LEAST(GREATEST(hi, current_date) + 7, current_date + 90);

  FOR d IN
    SELECT g::date FROM generate_series(lo::timestamp, hi::timestamp, interval '1 day') g
  LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "error_events" FOR VALUES FROM (%L) TO (%L)',
      'error_events_' || to_char(d, 'YYYYMMDD'),
      d::timestamp AT TIME ZONE 'UTC',
      (d + 1)::timestamp AT TIME ZONE 'UTC'
    );
  END LOOP;
END $$;

-- ④ 兜底分区：宁可进这里，也不要让写入失败。应长期为空
CREATE TABLE "error_events_default" PARTITION OF "error_events" DEFAULT;

-- ⑤ 搬数据（PG 按分区键自动分流）
INSERT INTO "error_events" SELECT * FROM "error_events_legacy";

-- ⑥ 约束：主键必须含分区键，这是 PG 硬规定
ALTER TABLE "error_events"
  ADD CONSTRAINT "error_events_pkey"
    PRIMARY KEY ("event_id", "timestamp"),
  ADD CONSTRAINT "error_events_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "error_events_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "error_groups"("id") ON DELETE SET NULL;

-- ⑦ 索引：建在父表上，自动分发到每个分区
CREATE INDEX "error_events_project_id_timestamp_idx"
  ON "error_events" ("project_id", "timestamp" DESC);

ANALYZE "error_events";

-- ⑧ 沙盒里可以直接删；真库先注释掉
-- DROP TABLE "error_events_legacy";