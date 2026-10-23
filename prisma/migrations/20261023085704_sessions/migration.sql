-- CreateTable
CREATE TABLE "sessions" (
    "id" VARCHAR(100) NOT NULL,
    "project_id" UUID NOT NULL,
    "user_key" VARCHAR(100),
    "started_at" TIMESTAMPTZ NOT NULL,
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    "had_error" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("project_id","id")
);

-- CreateIndex
CREATE INDEX "sessions_project_id_started_at_idx" ON "sessions"("project_id", "started_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
