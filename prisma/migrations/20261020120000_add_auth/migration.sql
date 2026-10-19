-- S4 鉴权：用户 + 组织成员（FR-5.4 / FR-5.5）
--
-- 两张新表都是纯新增，不动既有列，所以不需要回填 —— 这与 S1 那次
-- （给已有数据的表加 NOT NULL 外键）性质完全不同，风险也低得多。
--
-- 注意 users.password_hash 只有 VARCHAR(255)：装的是 scrypt 的
-- "算法$参数$盐$摘要"，不是明文密码。255 是给以后换参数（N/r/p 变长）留的余量。

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- 邮箱唯一：既是登录名，也是"一个邮箱只能注册一次"的硬保证。
-- 靠应用层先查后插是不够的 —— 并发注册两个请求会同时通过检查。
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_members_org_id_user_id_key"
    ON "organization_members"("org_id", "user_id");

-- 登录后第一条查询就是"我属于哪些组织"，按 user_id 建索引
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
