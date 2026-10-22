-- CreateTable
CREATE TABLE "affected_users" (
    "project_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_key" VARCHAR(100) NOT NULL,
    "first_seen" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_release" VARCHAR(100),

    CONSTRAINT "affected_users_pkey" PRIMARY KEY ("project_id","group_id","user_key")
);

-- AddForeignKey
ALTER TABLE "affected_users" ADD CONSTRAINT "affected_users_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
