-- MVP-B：一个用户只属于一个组织
--
-- 把 organization_members（多对多）压成 users.org_id + users.role（一对多）。
-- 判据是"同一时刻能有几个"：恰好 1 → 它是属性，不是实体。
--
-- ── 顺序不能换 ────────────────────────────────────────────────────────────
--   加列(可空) → 回填 → 兜底 → 收紧 NOT NULL + 外键 + 索引 → 最后才删旧表
-- 反过来先删表就再也回填不了了。这是所有"改关系形状"的迁移的通用套路。
--
-- 顺带给 projects 加上 (org_id, name) 唯一约束：同组织内重名会让看板的
-- 项目切换器出现两个完全一样的条目。

-- ① 先可空。直接 NOT NULL 会因为没有默认值而失败（表里已有数据）
ALTER TABLE "users" ADD COLUMN "org_id" UUID;
ALTER TABLE "users" ADD COLUMN "role" VARCHAR(20) NOT NULL DEFAULT 'member';

-- ② 从旧表回填。role 跟着成员关系一起搬过来（owner 仍然是 owner）
UPDATE "users" u
SET "org_id" = m."org_id",
    "role"   = m."role"
FROM "organization_members" m
WHERE m."user_id" = u."id";

-- ③ 兜底：万一有用户没有成员关系（历史脏数据 / 手工插的行），
--    塞进最早创建的那个组织。少了这一步，第 ④ 步会失败，
--    而报错只说 "column contains null values"，指不出是哪个用户。
UPDATE "users"
SET "org_id" = (SELECT "id" FROM "organizations" ORDER BY "created_at" ASC LIMIT 1)
WHERE "org_id" IS NULL;

-- ④ 收紧
ALTER TABLE "users" ALTER COLUMN "org_id" SET NOT NULL;

ALTER TABLE "users" ADD CONSTRAINT "users_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "这个组织里有谁" —— 将来的成员列表会用到
CREATE INDEX "users_org_id_idx" ON "users"("org_id");

-- ⑤ 旧表已经没有存在的理由了
DROP TABLE "organization_members";

-- ⑥ 项目名在同一组织内唯一
CREATE UNIQUE INDEX "projects_org_id_name_key" ON "projects"("org_id", "name");
