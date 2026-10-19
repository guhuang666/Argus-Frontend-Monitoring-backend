-- S1 多租户：项目密钥表（FR-5.2 / 5.6）
--
-- 独立表而不是 projects 加两列：一个项目可以同时有多把钥匙
-- （轮换宽限期、多环境各一把），两列只能"覆盖"。

CREATE TABLE "project_keys" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "public_key" VARCHAR(64) NOT NULL,
    "secret_key_hash" VARCHAR(64) NOT NULL,
    "label" VARCHAR(100),
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_keys_public_key_key" ON "project_keys"("public_key");
CREATE INDEX "project_keys_project_id_idx" ON "project_keys"("project_id");

ALTER TABLE "project_keys" ADD CONSTRAINT "project_keys_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
