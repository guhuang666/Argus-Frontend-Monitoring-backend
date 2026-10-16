-- MVP 单项目模式：去掉 error_groups.project_id
--
-- 唯一约束从 (project_id, grouping_version, fingerprint) 收窄为
-- (grouping_version, fingerprint)，作用域由"项目内"变成"全局"。
-- 两个字段都是 NOT NULL，所以约束依然有效 —— 归并没有被削弱。
--
-- 加回多项目时注意：project_id **必须 NOT NULL**（见 schema.prisma 的注释）。
-- 回填不再需要重建表，ALTER TABLE ADD COLUMN + UPDATE + SET NOT NULL 即可。
--
-- 执行前提：error_groups 必须是空表（已确认 0 行）。

-- DropForeignKey
ALTER TABLE "error_groups" DROP CONSTRAINT "error_groups_project_id_fkey";

-- DropIndex
DROP INDEX "error_groups_project_id_grouping_version_fingerprint_key";

-- DropIndex
DROP INDEX "error_groups_project_id_grouping_version_last_seen_idx";

-- DropIndex
DROP INDEX "error_groups_project_id_last_seen_idx";

-- DropIndex
DROP INDEX "error_groups_project_id_status_last_seen_idx";

-- AlterTable
ALTER TABLE "error_groups" DROP COLUMN "project_id";

-- CreateIndex
CREATE INDEX "error_groups_last_seen_idx" ON "error_groups"("last_seen" DESC);

-- CreateIndex
CREATE INDEX "error_groups_status_last_seen_idx" ON "error_groups"("status", "last_seen" DESC);

-- CreateIndex
CREATE INDEX "error_groups_grouping_version_last_seen_idx" ON "error_groups"("grouping_version", "last_seen" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "error_groups_grouping_version_fingerprint_key" ON "error_groups"("grouping_version", "fingerprint");
