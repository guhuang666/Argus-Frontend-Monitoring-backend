-- CreateTable
CREATE TABLE "error_groups" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "grouping_version" VARCHAR(20) NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "culprit" VARCHAR(500),
    "level" VARCHAR(20) NOT NULL DEFAULT 'error',
    "status" VARCHAR(20) NOT NULL DEFAULT 'unresolved',
    "times_seen" BIGINT NOT NULL DEFAULT 0,
    "users_seen" BIGINT NOT NULL DEFAULT 0,
    "first_seen" TIMESTAMPTZ NOT NULL,
    "last_seen" TIMESTAMPTZ NOT NULL,
    "first_release" VARCHAR(100),
    "last_release" VARCHAR(100),
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "error_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "error_groups_project_id_last_seen_idx" ON "error_groups"("project_id", "last_seen" DESC);

-- CreateIndex
CREATE INDEX "error_groups_project_id_status_last_seen_idx" ON "error_groups"("project_id", "status", "last_seen" DESC);

-- CreateIndex
CREATE INDEX "error_groups_project_id_grouping_version_last_seen_idx" ON "error_groups"("project_id", "grouping_version", "last_seen" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "error_groups_project_id_grouping_version_fingerprint_key" ON "error_groups"("project_id", "grouping_version", "fingerprint");

-- AddForeignKey
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "error_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
