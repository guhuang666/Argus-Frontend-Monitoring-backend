-- MVP-Util：私钥变成定位项目的唯一凭据
--
-- 起因：上传 Sourcemap 原来要求 `POST /projects/:projectId/sourcemaps` 同时给出
-- projectId 和私钥，于是"两个值必须配对"成了使用者的固定负担，配错只回一句 401。
-- 但私钥本身就是**项目级**凭据（project_keys 这一行就带 project_id），
-- 拿 sha256 反查一次就够 —— projectId 是冗余参数，也是那类错配错误的唯一来源。
--
-- 删掉 URL 里的 projectId 之后，服务端必须能按私钥哈希查行，所以：
--   1. 给 secret_key_hash 加索引（否则每次上传都是全表扫）
--   2. 加成**唯一**索引 —— 顺便把"一把私钥只属于一个项目"变成数据库级约束
--
-- 现有数据无冲突：project_keys 里每行的 secret_key_hash 都来自独立的随机私钥。

CREATE UNIQUE INDEX "project_keys_secret_key_hash_key"
    ON "project_keys"("secret_key_hash");
