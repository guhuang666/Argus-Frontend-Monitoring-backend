-- M6-1：告警规则与触发历史
--
-- 两张表的关系：alert_rules 1 —— N alert_events，删规则连带删历史（验收项）。
--
-- 外键为什么都是 CASCADE：
--   · alert_events.rule_id → alert_rules：规则删了，历史没有任何意义。
--     留着的后果是"孤儿历史"永远出现在列表里，而且点进去 404
--   · alert_rules.project_id → projects：**这条是我在给定模型之外补的**。
--     没有它，删项目会留下孤儿规则继续被评估、继续往废弃的群发消息，
--     而页面上已经看不到它们了 —— 排不出来的那种故障
--   （alert_events.project_id 与给模型一致，保持普通列、不建外键：
--     它是从规则冗余下来的查询列，级联路径已经由 rule_id 那条覆盖）
--
-- 索引的形状都是照着查询写的：
--   · alert_rules(project_id, enabled) —— 评估器唯一的查询：
--     「这个项目里所有启用的规则」。同时充当 project_id 外键的支撑索引
--   · alert_events(project_id, fired_at DESC) —— 列表页按项目+时间倒序翻页
--
-- 注意 metric / comparator / channel 是 VARCHAR 而不是 enum：
-- 取值由应用层白名单校验，加一个指标不需要动表结构。代价见 schema 里的说明。

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "metric" VARCHAR(30) NOT NULL,
    "comparator" VARCHAR(4) NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "window_minutes" INTEGER NOT NULL,
    "environment" VARCHAR(50),
    "release" VARCHAR(100),
    "channel" VARCHAR(20) NOT NULL,
    "webhook_url" VARCHAR(500) NOT NULL,
    "silence_minutes" INTEGER NOT NULL DEFAULT 30,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_fired_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "fired_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" DOUBLE PRECISION NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "error" VARCHAR(500),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rules_project_id_enabled_idx" ON "alert_rules"("project_id", "enabled");

-- CreateIndex
CREATE INDEX "alert_events_project_id_fired_at_idx" ON "alert_events"("project_id", "fired_at" DESC);

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
