-- AlterTable
ALTER TABLE "error_groups" ADD COLUMN     "last_environment" VARCHAR(50);

-- CreateIndex
CREATE INDEX "error_groups_project_id_times_seen_idx" ON "error_groups"("project_id", "times_seen" DESC);

-- CreateIndex
CREATE INDEX "error_groups_project_id_users_seen_idx" ON "error_groups"("project_id", "users_seen" DESC);
