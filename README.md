# Argus · 前端错误监控后端

> 可自托管的错误监控系统（Sentry 的精简版）：SDK 上报 → 指纹归并成「问题」→ Sourcemap 还原到源码 → 看板展示 + 阈值告警。

**技术栈**：NestJS 11 · Prisma 6 + PostgreSQL 16 · BullMQ + Redis 7 · Prometheus + Grafana

---

## 1. 它能做什么

| 能力 | 说明 |
|---|---|
| 异常上报 | `POST /api/v1/error`（单条）、`/error/batch`（批量）。公钥鉴权，滑动窗口限流 |
| 指纹归并 | 同一条错误归成一个「问题」，`times_seen` / `users_seen` 原子累加；状态流转让已解决的问题"回归"时自动重开 |
| Sourcemap 符号化 | 上传 `.map` → 按 `(项目, release)` 匹配 → 还原出源码文件/行/列/函数名 + 上下文代码；拿不到就降级显示压缩位置，**绝不因此丢事件** |
| 性能监控 | Web Vitals（LCP / CLS / INP）+ 分位数趋势（P50 / P75 / P95） |
| 概览 | 错误趋势、问题数、新增问题、PV / UV / 错误率；两个 Top 问题榜（按次数 / 按新增受影响用户） |
| 多租户 | 组织 / 项目 / 密钥；公钥只能写、私钥只能管，私钥只存哈希 |
| 告警 | 规则 CRUD、每 60 秒评估、飞书 / Slack / 钉钉推送、静默期 + 触发历史 |
| 可观测性 | `/health/live` 与 `/health/ready` 分离、Prometheus 指标、Grafana 面板、pino 结构化日志 |

---

## 2. 架构

```
                         ┌──────────────────────────────┐
  SDK（浏览器）──────────▶│ API 进程  :3000              │
    X-Argus-Key          │  · 上报 / 查询 HTTP 接口      │
                         │  · JWT 鉴权 + 限流            │
  看板（Vite/React）─────▶│  · 只投递任务，不消费         │
    JWT                  └───────┬──────────────┬───────┘
                                 │              │
                        ┌────────▼───────┐  ┌───▼──────────────┐
                        │ PostgreSQL 16  │  │ Redis 7          │
                        │ 明细 + 聚合表   │  │ 队列 / 限流 / 锁 │
                        └────────▲───────┘  └───▲──────────────┘
                                 │              │
                         ┌───────┴──────────────┴───────┐
                         │ worker 进程（无 HTTP 端口）   │
                         │  · BullMQ 消费者：归并/符号化  │
                         │  · 告警评估器：每 60s 一轮     │
                         │  · 指标端点 :9464              │
                         └──────────────────────────────┘

  Prometheus :9090 ──抓 /metrics──▶ API :3000 + worker :9464 ──▶ Grafana :3001
```

---

## 3. 目录结构

```
src/
├── auth/           JWT 鉴权、项目归属校验、密码哈希
├── keys/           公钥 → 项目解析（带 30s 缓存）
├── projects/       项目 CRUD、密钥发放
├── error-events/   上报入库、事件查询
├── grouping/       ★ 归并核心：指纹、栈解析、符号化、worker、小时聚合
├── issues/         问题列表 / 详情 / 状态流转 / facets
├── performance/    性能指标上报与查询
├── sourcemaps/     .map 上传流水线（与 CLI 共用 artifact-path 规则）
├── stats/          概览与性能分位数趋势
├── alerts/         告警：规则 CRUD（API）+ 评估/投递（worker）
├── sessions/       页面会话（错误率的分母）
├── ratelimit/      滑动窗口限流（Redis Lua）
├── queue/          BullMQ 连接与队列常量
├── metrics/        Prometheus 指标（API 与 worker 两个端点）
├── logging/        pino 结构化日志 + traceId
├── health/         live / ready 探针
├── prisma/         PrismaService（@Global）
└── common/         密钥生成、DTO 基类、工具
test/               e2e（真 PG + 真 Redis，跑在 ?schema=e2e）
prisma/             schema + migrations
scripts/            seed / 建项目 / 回填 / 对账 / 压测 / webhook 模拟
deploy/             Prometheus 抓取配置、Grafana provisioning
```

---

## 4. 快速开始

### 4.1 本地开发（推荐）

```bash
# 1) 只拉起依赖（PG + Redis）
docker compose up -d postgres redis

# 2) 装依赖 + 建表
npm install
npx prisma migrate deploy

# 3) 初始化：管理员账号 + 默认项目 + 密钥（会重置管理员密码）
npm run seed

# 4) 同时起 API 与 worker（两个进程，缺一个就不会归并）
npm run dev
```

`.env` 至少需要这两项（`.env` 不进仓库）：

```dotenv
DATABASE_URL="postgresql://argus:argus@127.0.0.1:5432/argus?schema=public"
JWT_SECRET="<32 字节随机 hex>"   # 缺失时鉴权模块 fail-closed，服务直接起不来
```

新建一个独立项目（拿到公钥 / 私钥）：

```bash
npm run project:new -- "我的商城"
```

### 4.2 全容器

```bash
docker compose up -d    # postgres / redis / migrate / api / worker / web / prometheus / grafana
```

| 服务 | 地址 |
|---|---|
| API | http://localhost:3000 |
| 看板（web 镜像） | http://localhost:8080 |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| worker 指标 | http://localhost:9464/metrics |

---

## 5. 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL 连接串；`prisma.config.ts` 与运行时共用 |
| `JWT_SECRET` | ✅ | — | 缺失则启动失败（fail-closed），不允许临时密钥凑合 |
| `PORT` | | `3000` | API 端口 |
| `REDIS_HOST` / `REDIS_PORT` | | `127.0.0.1` / `6379` | 队列、限流、告警锁共用这一套 |
| `UPLOADS_DIR` | | `uploads` | Sourcemap 落盘根目录（已 gitignore） |
| `RATE_LIMIT_ENABLED` | | `true` | 设 `false` 用于压测对照 |
| `LOG_LEVEL` | | `info` | `silent` / `debug` / `info` / `warn` / `error` |
| `DASHBOARD_URL` | | `http://localhost:5173` | 告警消息里的链接基址（必须是绝对地址） |
| `ALERT_EVALUATOR_INTERVAL_MS` | | `60000` | 评估周期；小于 1000 会被忽略 |
| `WORKER_METRICS_PORT` | | `9464` | worker 独立的指标端口 |
| `NODE_ENV` | | — | 为 `production` 时日志走 JSON |
| `E2E_DATABASE_URL` | | — | 仅 e2e：覆盖测试库地址（默认 `?schema=e2e`） |

`scripts/` 下的脚本还会读 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ARGUS_ORG_SLUG`。

---

## 6. 常用命令

```bash
npm run dev              # 构建 + 同时起 api 与 worker（watch）
npm run dev:api          # 只起 API
npm run dev:worker       # 只起 worker
npm run build            # nest build → dist/
npm run seed             # 初始化管理员 / 默认项目（会重置管理员密码）
npm run project:new -- "名字"

npm test                 # 单测（已内置 --runInBand）
npm run test:watch       # 保存即重跑
npm run test:e2e         # e2e（需要 PG + Redis，跑在 e2e schema）
npm run lint             # eslint --fix

npm run stats:backfill   # 用明细重建小时聚合表（幂等，支持 --dry-run）
npm run stats:reconcile  # 对账：聚合 vs 明细，不一致时退出码 1
node scripts/load-test.mjs      # 压测上报入口
node scripts/webhook-mock.cjs   # 本地假 webhook，验证告警投递
```

---

## 7. API 一览

三类鉴权，别混：

| 类别 | 凭据 | 谁在用 |
|---|---|---|
| **上报** | 请求头 `X-Argus-Key: argus_pub_...` | SDK |
| **读接口** | `Authorization: Bearer <JWT>` | 看板 |
| **公开** | 无 | 探针 / Prometheus |

```http
# 上报（公钥）
POST   /api/v1/error                  单条异常
POST   /api/v1/error/batch            批量
POST   /api/v1/performance            性能指标

# 上传 Sourcemap（私钥：Authorization: Bearer argus_sec_...）
POST   /api/v1/sourcemaps

# 读接口（JWT）
GET    /api/v1/error?projectId=       异常明细
GET    /api/v1/issues                 问题列表（分页 / 状态筛选）
GET    /api/v1/issues/facets          筛选器可选值
GET    /api/v1/issues/:id             问题详情 + 事件分页
PATCH  /api/v1/issues/:id             状态流转（resolved / ignored / archived）
GET    /api/v1/performance?projectId= 性能明细
GET    /api/v1/stats/overview         概览（趋势 / 总量 / PV / UV / 错误率）
GET    /api/v1/stats/performance      分位趋势（metric=lcp|cls|inp）
GET    /api/v1/projects               项目列表
GET    /api/v1/projects/:projectId    项目详情（含公钥）
POST   /api/v1/projects               新建项目
GET    /api/v1/alert-rules            告警规则列表
POST   /api/v1/alert-rules            新建规则
PATCH  /api/v1/alert-rules/:id        修改规则
DELETE /api/v1/alert-rules/:id        删除规则（连带删触发历史）
GET    /api/v1/alert-events           触发历史
POST   /api/v1/auth/register|login|logout
GET    /api/v1/auth/me

# 公开
GET    /api/v1/health/live            进程活着 → 200（挂了要重启进程）
GET    /api/v1/health/ready           依赖全通 → 200，否则 503（只是暂时不接流量）
GET    /metrics                       Prometheus 抓取（无 api/v1 前缀）
```

---

## 8. 数据模型（`prisma/schema.prisma`）

| 表 | 一行代表什么 | 关键约束 |
|---|---|---|
| `organizations` / `users` | 组织与成员 | — |
| `projects` | 一个被监控的应用 | 同组织内名称唯一 |
| `project_keys` | 一把公钥或私钥 | 公钥明文，私钥只存 sha256 |
| `error_events` | 一条原始上报（明细保留 30 天） | `processed_at IS NULL` 是归并的幂等闸门 |
| `error_groups` | 一个「问题」 | `(project_id, grouping_version, fingerprint)` 唯一 |
| `affected_users` | 去重表：谁被这个问题影响过 | 主键 `(项目, 问题, 用户)`，插入用 `ON CONFLICT DO NOTHING` |
| `issue_stats_hourly` | 每小时 × 每个问题的**事件次数** | 主键 `(project_id, group_id, hour)`，`hour` 必须是 **UTC 整点**；用户数**不**预聚合（见 §10.4） |
| `sessions` | 一次页面会话 | `had_error` 是错误率的分子 |
| `performance_metrics` | 一次页面加载的三个 Web Vitals | 三个指标都可空（"没测到" ≠ "测得 0"） |
| `releases` / `sourcemap_files` | 版本与它的 `.map` 对应关系 | `(release_id, artifact_path)` 唯一 |
| `alert_rules` / `alert_events` | 告警规则与每次触发 | 双外键 CASCADE：删规则连历史，删项目连规则 |

---

## 9. 两个进程，一条边界

这是本项目最容易踩的架构纪律：

```
app.module.ts   ──▶ API 进程：HTTP、鉴权、限流、投递任务
                    ✗ 绝不 import GroupingModule / EvaluationModule

worker.ts       ──▶ worker 进程：消费队列、归并、符号化、告警评估
                    ✗ 没有 HTTP 端口，不做鉴权
```

**为什么**：API 可以水平扩容。归并或告警评估一旦进了 API，每个副本都会做一遍 —— 同一条错误被归并 N 次（计数翻倍）、同一次告警发 N 条消息。

worker 侧还有一层 Redis 锁（`alert:evaluator:lock`），保证即使 worker 起了多副本，同一时刻也只有一个在评估。

---

## 10. 几个关键设计

1. **归并幂等**：先 `UPDATE error_events SET processed_at = now() WHERE event_id IN (...) AND processed_at IS NULL RETURNING ...`，一条 SQL 抢整批；抢到的那些才归并。队列语义是 at-least-once，重复消费必须无害。
2. **指纹带版本**：`v1-raw`（压缩位置）与 `v2-symbolicated`（源码位置）并存于唯一键。M3 上线时做一次受控重算，避免同一错误在符号化前后裂成两个问题。
3. **计数一律用 `increment`**：`times_seen`、`users_seen`、`event_count` 都让数据库做加法。读改写会在并发下静默丢计数。
4. **预聚合表 + 回填 + 对账**：趋势读 `issue_stats_hourly`（明细 30 天后就没了）；`stats:backfill` 可重跑，`stats:reconcile` 用 **4 条**恒等式校验。小时桶一律按 UTC 截断，**禁止 `date_trunc`**（它会跟着会话时区走）。
   **表里只存事件数**：受影响用户数不预聚合 —— 批次归并时"新增用户"是整批一个数、拆不到小时，看板改为直接查 `affected_users.first_seen`（`/stats/overview` 的 `byUsers` 榜）。
5. **列号 0/1-based 只在两处换算**：sourcemap 内部是 0-based，浏览器是 1-based；查表前 `-1`、展示时 `+1`，别的地方不要动。
6. **符号化失败即降级**：没 release、没 map、map 坏了，都只让这一帧显示压缩位置；抛错会把整条事件推进 DLQ。
7. **限流 fail-open**：Redis 挂了就放行并打日志。监控系统的第一职责是记录事实，为了限流丢掉上报是本末倒置。
8. **告警两条纪律**：窗口 `[now-window, now)` 且整轮共用一个 `now`；**推送成功才更新 `lastFiredAt`**（否则静默期会替用户"确认"一条他根本没收到的消息）。
9. **探针拆两个**：`live` 不查依赖（挂了要重启进程），`ready` 查 PG / Redis / 队列（挂了只是不接流量）。混成一个会让编排系统在 Redis 抖动时重启所有实例。

---

## 11. 测试

```bash
npm test              # 单测：不连 PG / Redis，全部用假对象
npm run test:e2e      # e2e：真 PG + 真 Redis，跑在 ?schema=e2e
```

- 单测覆盖：指纹与栈解析、符号化、限流判定、健康检查、统计接口、告警评估 / 投递、事件入库、密钥与会话。
- ⚠ **归并 worker（`grouping/error-event.processor`）的单测仍在迁移到批量路径**：删掉单条处理路径后，那批用例还按老形状构造 job 载荷，目前是红的（`npm test` 会失败）。其余模块的单测不受影响；补测试时把 `jobLike()` 改成 `{ eventIds: [...] }` 并重录断言即可。
- e2e 首次运行前要先给 e2e schema 建表：

```bash
$env:DATABASE_URL='postgresql://argus:argus@127.0.0.1:5432/argus?schema=e2e'
npx prisma migrate deploy
```

e2e 的环境变量集中在 `test/e2e-setup.ts`（`setupFiles`，早于一切测试文件）：强制指向 `?schema=e2e`、关限流、日志静音、`UPLOADS_DIR=uploads-e2e`。**同一个 PG 实例、不同 schema**，开发数据不会被碰。

---

## 12. CI

`.github/workflows/ci.yml`：`npm ci` → `npx prisma generate` → `build` → `test` → `migrate deploy`（e2e schema）→ `test:e2e`。

- `npx prisma generate` **不可省**：`generated/` 在 `.gitignore` 里，新 clone 没有 Prisma 客户端，`build` 会直接报 `TS2307`。
- job 里的 `DATABASE_URL` / `JWT_SECRET` 是假值，只为让 `prisma.config.ts` 与鉴权模块能加载；CI 不需要真秘密。

---

## 13. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `prisma migrate dev` 报 "non-interactive" | 它需要 TTY。改用 `npx prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --script` 生成 SQL，再 `npx prisma migrate deploy` |
| `prisma generate` 报 `EPERM … query_engine-windows.dll.node` | 有 API 进程正占着引擎 DLL。先停掉进程再生成 |
| `jest` 报 `spawn EPERM` | 本机禁止子进程 fork。脚本已内置 `--runInBand`，别再手动去掉 |
| e2e 报 `relation "..." does not exist` | e2e schema 没建表，先按第 11 节对 `?schema=e2e` 跑一次 `migrate deploy` |
| 上报返回 401 | 公钥错 / 项目已停用 / 请求头不是 `X-Argus-Key`（公钥有 30s 缓存，改完等一会儿） |
| 事件入库了但不归并 | worker 没起，或 `error-events-dlq` 有积压（DLQ 没有消费者，只能人工看） |
| `/health/ready` 返回 503 | 响应体的 `failed[]` 会写明是 `pg` / `redis` / `queue` 哪一项 |
| 看板上显示"未符号化" | 该 `release` 没上传 map，或 `artifactPath` 与上传时不一致（两边都不带 origin / query） |

---

## 14. 许可

内部项目，未附开源许可。
