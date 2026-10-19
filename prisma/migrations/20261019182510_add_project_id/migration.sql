-- S0 多租户：给四张业务表加 project_id（NOT NULL）
--
-- 库里已有单租户时代的存量数据，直接 `ADD COLUMN ... NOT NULL` 会失败
-- （Postgres 无法给已有行凭空造值），所以分三步：
--   ① 加可空列 ② 回填默认项目 ③ 设 NOT NULL
--
-- 回填目标 = scripts/seed.cjs 创建的默认项目：
--   ac17c25a-2cae-4f14-94b1-7f7118c92791
-- 在全新空库上执行本迁移时，几条 UPDATE 影响 0 行，SET NOT NULL 依然成立 ——
-- 也就是说这条迁移在"有数据"和"空库"两种情况下都安全。
--
-- ⚠️ project_id 必须 NOT NULL：Postgres 的唯一索引把 NULL 视为互不相同，
-- 可空会让 (project_id, grouping_version, fingerprint) 形同虚设。

-- ① 加可空列
ALTER TABLE "error_events"        ADD COLUMN "project_id" UUID;
ALTER TABLE "error_groups"        ADD COLUMN "project_id" UUID;
ALTER TABLE "performance_metrics" ADD COLUMN "project_id" UUID;
ALTER TABLE "releases"            ADD COLUMN "project_id" UUID;

-- ② 回填（存量数据全部归到默认项目）
UPDATE "error_events"        SET "project_id" = 'ac17c25a-2cae-4f14-94b1-7f7118c92791' WHERE "project_id" IS NULL;
UPDATE "error_groups"        SET "project_id" = 'ac17c25a-2cae-4f14-94b1-7f7118c92791' WHERE "project_id" IS NULL;
UPDATE "performance_metrics" SET "project_id" = 'ac17c25a-2cae-4f14-94b1-7f7118c92791' WHERE "project_id" IS NULL;
UPDATE "releases"            SET "project_id" = 'ac17c25a-2cae-4f14-94b1-7f7118c92791' WHERE "project_id" IS NULL;

-- ③ 设 NOT NULL
ALTER TABLE "error_events"        ALTER COLUMN "project_id" SET NOT NULL;
ALTER TABLE "error_groups"        ALTER COLUMN "project_id" SET NOT NULL;
ALTER TABLE "performance_metrics" ALTER COLUMN "project_id" SET NOT NULL;
ALTER TABLE "releases"            ALTER COLUMN "project_id" SET NOT NULL;

-- ④ 外键（删项目时级联删掉它的所有数据）
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "performance_metrics" ADD CONSTRAINT "performance_metrics_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⑤ 唯一约束改为三元组 / 二元组
DROP INDEX "error_groups_grouping_version_fingerprint_key";
CREATE UNIQUE INDEX "error_groups_project_id_grouping_version_fingerprint_key"
  ON "error_groups"("project_id", "grouping_version", "fingerprint");

DROP INDEX "releases_version_key";
CREATE UNIQUE INDEX "releases_project_id_version_key"
  ON "releases"("project_id", "version");

-- ⑥ 索引一律以 project_id 打头（TC-08：查询必须带 projectId，否则吃不到索引）
DROP INDEX "error_events_timestamp_idx";
CREATE INDEX "error_events_project_id_timestamp_idx"
  ON "error_events"("project_id", "timestamp" DESC);

DROP INDEX "error_groups_last_seen_idx";
CREATE INDEX "error_groups_project_id_last_seen_idx"
  ON "error_groups"("project_id", "last_seen" DESC);

DROP INDEX "error_groups_status_last_seen_idx";
CREATE INDEX "error_groups_project_id_status_last_seen_idx"
  ON "error_groups"("project_id", "status", "last_seen" DESC);

DROP INDEX "error_groups_grouping_version_last_seen_idx";
CREATE INDEX "error_groups_project_id_grouping_version_last_seen_idx"
  ON "error_groups"("project_id", "grouping_version", "last_seen" DESC);

DROP INDEX "performance_metrics_timestamp_idx";
CREATE INDEX "performance_metrics_project_id_timestamp_idx"
  ON "performance_metrics"("project_id", "timestamp" DESC);

DROP INDEX "performance_metrics_url_timestamp_idx";
CREATE INDEX "performance_metrics_project_id_url_timestamp_idx"
  ON "performance_metrics"("project_id", "url", "timestamp" DESC);
