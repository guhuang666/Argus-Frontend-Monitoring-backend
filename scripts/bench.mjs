#!/usr/bin/env node
/**
 * 上报接口压测脚手架（M7-T4）—— 支持单条与批量两种模式
 *
 *   node --env-file=.env scripts/bench.mjs [并发] [秒数] [轮数] \
 *        [--batch=N] [--out <csv>] [--session u|f] [--user u|f]
 *
 * 例：
 *   node --env-file=.env scripts/bench.mjs                            # 单条：50 并发 / 30 秒 / 3 轮
 *   node --env-file=.env scripts/bench.mjs 50 30 3 --batch=50         # 批量：每次请求打 50 条
 *   node --env-file=.env scripts/bench.mjs 5 3 1 --batch=10           # 冒烟：先确认通路
 *   node --env-file=.env scripts/bench.mjs 50 30 3 --batch=50 --out bench/b50.csv
 *
 * ── 这次新增了什么 ──────────────────────────────────────────────────────
 * `--batch=N`：一次请求携带 N 条事件。N=1 时行为与旧版**完全一致**（同一个 URL、
 * 同一个 body、同一个成功状态码）。N>1 时：
 *   · 改打 `/api/v1/error/batch`（在单条路径后加 `/batch`）
 *   · body 变成 `{ events: [...] }`
 *   · 成功状态码是 202（单条是 201）
 *   · 多输出一个关键指标 **events/s = rps × N**
 *
 * ── 为什么必须同时报 rps 和 events/s ────────────────────────────────────
 * 批量之后这两个数会分离：rps 可能从 331 掉到 20，但 events/s 从 331 涨到 1000。
 * 只看 rps 会得出"批量让性能下降"的错误结论 —— 它衡量的是**请求数**不是**事件数**。
 * 报告里凡涉及"吞吐"的地方，一律用 events/s。
 *
 * ── 为什么 event_id 换成计数器而不是 randomUUID ─────────────────────────
 * 批量模式下每请求要造 N 个 id。50 并发 × 300 req/s × 50 条 = 每秒 75 万个对象，
 * 而 `randomUUID()` 走 CSPRNG —— **压测端会先饱和**，测出来的是 autocannon 的上限。
 * 改用 `runTag-序号`：单调递增、保证唯一、几乎零成本。
 * 副作用：id 从 36 字符的 UUID 变成约 16 字符，单条 body 小约 20 字节（<1.5%）。
 *
 * ── 为什么不用 autocannon 命令行直接打 ──────────────────────────────────
 * 命令行版做不到这三件事：
 *   ① 每条事件的 event_id 必须唯一（否则全走 duplicate 分支，测的不是写入路径）
 *      —— 用 requests[].setupRequest 每请求换 body
 *   ② 开跑前的预检：公钥错 / 限流没关 / 路由不存在，在压测表里都只表现为
 *      "一堆非 2xx"，不预检就得事后猜
 *   ③ 3 轮取中位数并输出 CSV —— SRS §13.1 明确要求
 *
 * ── ⚠️ 两个已实测踩过的坑（别改回去）──────────────────────────────────
 *   · `idReplacement: true` + body 里写 `[<id>]`：本环境下**全部请求挂死**。
 *     改用 setupRequest。
 *   · 顶层 `setupRequest`（写在 autocannon({...}) 里，不在 requests[] 内）：
 *     **不生效**，实测全部 non-2xx。必须写在 `requests: [{ setupRequest }]` 里。
 *
 * ── 公钥从哪来 ──────────────────────────────────────────────────────────
 * 优先 BENCH_KEY，其次 ARGUS_PUBLIC_KEY（backend/.env 里就有）。
 *   临时换一把不用改 .env：$env:BENCH_KEY='argus_pub_...'
 *   ⚠️ bench schema 的公钥与 public schema 不同，重建过 bench 库会换钥匙 → 全线 401。
 *
 * ── 环境要求（否则数字不可比）─────────────────────────────────────────
 *   docker compose -f docker-compose.yml -f docker-compose.bench.yml up -d
 *   → api 固定 2 核、RATE_LIMIT_ENABLED=false、LOG_LEVEL=warn
 *
 * ── 跑之前先清干净（批量模式尤其重要）──────────────────────────────────
 *   每组之间要同时清 **表** 和 **队列**，否则上一轮的 job 会让下一轮背负积压：
 *     docker exec argus-postgres-1 psql -U argus -d argus -q -c \
 *       "TRUNCATE bench.error_events, bench.error_groups, bench.issue_stats_hourly, \
 *        bench.sessions, bench.affected_users, bench.performance_metrics CASCADE;"
 *     docker exec argus-redis-1 sh -c \
 *       "redis-cli --scan --pattern 'bull:*' | xargs -r redis-cli del"
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import autocannon from 'autocannon';

/* ==========================================================================
 * ① 参数与配置
 * ======================================================================== */

/** 单请求最多多少条。必须与后端 `MAX_BATCH_EVENTS`、SDK `MAX_BATCH` 三者一致 */
const MAX_BATCH = 50;

/**
 * 单条上报的 URL。批量模式会在它的路径后面加 `/batch`
 * （后端 controller 里是 `@Post('error/batch')`，前缀 `api/v1`）。
 */
const SINGLE_URL = process.env.BENCH_URL ?? 'http://localhost:3000/api/v1/error';

/**
 * 公钥解析：BENCH_KEY > ARGUS_PUBLIC_KEY，并记录来源。
 *
 * 用 `||` 而不是 `??`：`??` 只对 null/undefined 回退。一旦 BENCH_KEY 被设成空串
 * 就会永远不去看 ARGUS_PUBLIC_KEY —— 表现是"明明 .env 里有钥匙，脚本却说缺少公钥"。
 *
 * 为什么打印来源：shell 环境变量**优先于** `--env-file`（Node 的 --env-file
 * 不覆盖已存在的变量），而这件事是完全静默的。
 */
function resolveKey() {
  for (const name of ['BENCH_KEY', 'ARGUS_PUBLIC_KEY']) {
    const value = process.env[name]?.trim();
    if (value) return { key: value, source: name };
  }
  return { key: '', source: null };
}

const { key: KEY, source: KEY_SOURCE } = resolveKey();

// ── 参数：位置参数 [并发] [秒数] [轮数]，外加 --batch / --out / --session / --user ──
const argv = process.argv.slice(2);
const positional = [];
let outPath = null;
let batchSize = 1;
/** 会话口径，见 buildEvent 上方注释。默认 unique：测真实上限 */
let sessionMode = 'unique';
/** 用户口径，见 buildEvent 上方注释。默认 unique：测 UV / 影响用户数的上界 */
let userMode = 'unique';

function die(message) {
  process.stderr.write(`\n✗ ${message}\n\n`);
  process.exit(1);
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--out' || arg === '-o') {
    outPath = argv[i + 1] ?? null;
    if (outPath === null) die('--out 后面要跟一个文件路径，例如：--out bench/c50.csv');
    i += 1;
  } else if (arg.startsWith('--out=')) {
    outPath = arg.slice('--out='.length);
    if (outPath === '') die('--out= 后面要跟一个文件路径');
  } else if (arg === '--batch' || arg === '-b') {
    batchSize = Number(argv[i + 1] ?? NaN);
    i += 1;
  } else if (arg.startsWith('--batch=')) {
    batchSize = Number(arg.slice('--batch='.length));
  } else if (arg.startsWith('-b=')) {
    batchSize = Number(arg.slice('-b='.length));
  } else if (arg === '--session') {
    sessionMode = argv[i + 1] ?? '';
    i += 1;
  } else if (arg.startsWith('--session=')) {
    sessionMode = arg.slice('--session='.length);
  } else if (arg === '--user') {
    userMode = argv[i + 1] ?? '';
    i += 1;
  } else if (arg.startsWith('--user=')) {
    userMode = arg.slice('--user='.length);
  } else {
    positional.push(arg);
  }
}

const CONNECTIONS = Number(positional[0] ?? 50);
const DURATION = Number(positional[1] ?? 30);
const ROUNDS = Number(positional[2] ?? 3);

/** 预热时长：冷启动（JIT、连接池、V8 优化）会污染前几秒，单独跑一次丢掉 */
const WARMUP_SECONDS = 3;

const parsed = new URL(SINGLE_URL);
const ORIGIN = parsed.origin;
/** 单条路径；去掉尾部斜杠，免得拼出 `//batch` */
const SINGLE_PATH = parsed.pathname.replace(/\/+$/, '');
/** 批量路径：单条路径 + `/batch`，可用 BENCH_BATCH_PATH 覆盖 */
const BATCH_PATH = process.env.BENCH_BATCH_PATH ?? `${SINGLE_PATH}/batch`;

const PATH = batchSize > 1 ? BATCH_PATH : SINGLE_PATH;
const TARGET_URL = `${ORIGIN}${PATH}`;
/** 批量端点回 202（Accepted），单条端点回 201（Created） */
const EXPECTED_STATUS = batchSize > 1 ? 202 : 201;

if (!Number.isInteger(CONNECTIONS) || CONNECTIONS < 1) die(`并发数必须是正整数，收到 ${CONNECTIONS}`);
if (!Number.isInteger(DURATION) || DURATION < 1) die(`时长必须是正整数秒，收到 ${DURATION}`);
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) die(`轮数必须是正整数，收到 ${ROUNDS}`);
if (!Number.isInteger(batchSize) || batchSize < 1) die(`--batch 必须是 ≥1 的整数，收到 ${batchSize}`);
if (batchSize > MAX_BATCH) {
  die(
    [
      `--batch=${batchSize} 超过上限 ${MAX_BATCH}。`,
      '',
      `  后端 DTO 的 @ArrayMaxSize(${MAX_BATCH}) 会直接回 400，`,
      `  SDK 的 MAX_BATCH 也是 ${MAX_BATCH}（它攒满即发，永远不会发更多）。`,
      '  三处必须一致，否则测的是一条客户端根本发不出来的路径。',
    ].join('\n'),
  );
}
if (sessionMode !== 'unique' && sessionMode !== 'fixed') {
  die(`--session 只接受 unique 或 fixed，收到 ${JSON.stringify(sessionMode)}`);
}
if (userMode !== 'unique' && userMode !== 'fixed') {
  die(`--user 只接受 unique 或 fixed，收到 ${JSON.stringify(userMode)}`);
}
if (KEY === '') {
  die(
    [
      '缺少上报公钥。两种给法：',
      '',
      '  ① 用 .env 里的（node --env-file=.env ...）',
      "  ② 临时指定：$env:BENCH_KEY='argus_pub_...'",
      '',
      '  注意：公钥以 argus_pub_ 开头；argus_sec_ 是私钥，传进请求头只会 401。',
    ].join('\n'),
  );
}
if (KEY.startsWith('argus_sec_')) {
  die('你填的是私钥（argus_sec_...），上报只需要公钥（argus_pub_...）。');
}

/* ==========================================================================
 * ② 请求体：一条"像真的"错误事件 + 批量外壳
 *
 * 字段与上限严格对齐 backend/src/error-events/dto/ingest-error.dto.ts：
 *   event_id 1~128   mechanism 三选一   type 1~128   message 1~2000
 *   stack ≤64KB      url ≤2048        user_agent ≤512
 *   source ≤512      release ≤100     environment ≤50    user.id 1~100
 *
 * 为什么字段要填全：少填可选字段会让 JSON.parse 的成本低于真实场景，
 * 测出来的吞吐会虚高。这里按 SDK 实际会发的形状来。
 * ======================================================================== */

const HEADERS = {
  'content-type': 'application/json',
  'x-argus-key': KEY,
  accept: 'application/json',
};

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'length')",
  '    at renderSummary (http://127.0.0.1:8017/assets/index-BF0Gzh2j.js:1:23456)',
  '    at applyProps (http://127.0.0.1:8017/assets/index-BF0Gzh2j.js:1:18988)',
  '    at commitWork (http://127.0.0.1:8017/assets/index-BF0Gzh2j.js:1:15632)',
  '    at performUnitOfWork (http://127.0.0.1:8017/assets/index-BF0Gzh2j.js:1:14210)',
  '    at workLoopSync (http://127.0.0.1:8017/assets/index-BF0Gzh2j.js:1:13945)',
  '    at renderRootSync (http://127.0.0.1:8017/assets/index-BF0Gzh2j.js:1:13702)',
  '    at performSyncWorkOnRoot (http://127.0.0.1:8017/assets/index-BF0Gzh2j.js:1:12311)',
].join('\n');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * event_id 生成：`runTag-序号`。
 *
 * runTag 每次启动取一次（Date.now 的 36 进制），保证**跨轮次、跨运行都不撞**；
 * 序号单调递增，保证**同一运行内唯一**。合计约 16 字符，远小于 128 的上限。
 *
 * 不用 randomUUID：批量模式下每秒要造几十万个 id，CSPRNG 会让**压测端**成为瓶颈
 * （见文件头说明）。
 */
const RUN_TAG = Date.now().toString(36);
let eventSeq = 0;
function nextEventId() {
  eventSeq += 1;
  return `${RUN_TAG}-${eventSeq}`;
}

/**
 * 生成一条事件。
 *
 * ── session_id 的两种口径（--session）──────────────────────────────────
 * unique（默认）：由 event_id 派生 → 每条一个全新会话。
 *   sessions 表每次 INSERT 新行，不再有「同一行」的行锁竞争。
 *   这是**上限口径**：真实流量里一个会话通常带多条错误，真实值会略低于它。
 *   ⚠️ 代价：sessions 按事件数增长，批量模式下一轮能多出几十万行。
 *
 * fixed：全部共用 sess-bench-0001 → 那一行被反复 UPSERT。
 *   高并发下 PG 会对同一行加行锁，排队时间被算进 P99，
 *   于是测到的不是接口上限，而是**同一行的锁排队上限**。仅作对照。
 *
 * ── user.id 的两种口径（--user）────────────────────────────────────────
 * unique（默认）：u_<event_id> → 每条一个新用户，UV / 影响用户数取上界。
 * fixed：全部 u_bench_0001 → UV 去重恒定。
 *
 * 要完全复现改动前的请求体：--session=fixed --user=fixed
 */
const FIXED_SESSION_ID = 'sess-bench-0001';
const FIXED_USER_ID = 'u_bench_0001';

function buildEvent(eventId) {
  const sessionId = sessionMode === 'fixed' ? FIXED_SESSION_ID : `sess-${eventId}`;
  const userId = userMode === 'fixed' ? FIXED_USER_ID : `u_${eventId}`;
  return {
    event_id: eventId,
    session_id: sessionId,
    mechanism: 'onerror',
    type: 'TypeError',
    message: "Cannot read properties of undefined (reading 'length')",
    stack: STACK,
    source: '/assets/index-BF0Gzh2j.js:1:23456',
    timestamp: '2026-10-30T12:00:00.000Z',
    url: 'http://127.0.0.1:8017/orders',
    user_agent: USER_AGENT,
    sdk: { name: 'argus.browser', version: '0.1.0' },
    release: 'demo@1.0.0',
    environment: 'local',
    user: { id: userId },
    breadcrumbs: [
      { timestamp: 1, category: 'click', message: 'button#checkout' },
      { timestamp: 2, category: 'http', message: 'GET /api/order → 500', data: { status: 500 } },
      {
        timestamp: 3,
        category: 'navigation',
        message: '/orders → /checkout',
        data: { from: '/orders', to: '/checkout' },
      },
    ],
  };
}

/**
 * 造一个请求体（已序列化的字符串）。
 *
 * 单条模式：body 就是事件对象本身 —— 与旧脚本逐字节同形。
 * 批量模式：body 是 `{ events: [...] }` —— 与 SDK 的 `sendBatch()` 同形。
 */
function makeBody() {
  if (batchSize === 1) return JSON.stringify(buildEvent(nextEventId()));

  const events = new Array(batchSize);
  for (let i = 0; i < batchSize; i += 1) events[i] = buildEvent(nextEventId());
  return JSON.stringify({ events });
}

/** 采样一次体积（会消耗若干 id，对结果无影响） */
const BODY_BYTES = Buffer.byteLength(makeBody(), 'utf8');

/**
 * Express 默认的 JSON body 上限是 100 KB。批量模式下很容易踩到：
 * 50 条 × 1.5 KB ≈ 75 KB，只要栈再长一点就超。
 * 超了会回 413，而 SDK **不重试**——等于整批事件静默丢弃。
 */
if (BODY_BYTES > 95_000) {
  process.stderr.write(
    [
      '',
      `⚠️ 单个请求体 ${BODY_BYTES} 字节，已接近 Express 默认的 100 KB 上限。`,
      '   如果服务端回 413，需要在 backend/src/main.ts 里把 json 的 limit 提到 1mb：',
      "     app.useBodyParser('json', { limit: '1mb' })",
      '',
    ].join('\n'),
  );
}

/* ==========================================================================
 * ③ 预检：一次请求先确认"能通"
 *
 * 401 / 429 / 400 / 404 / 413 在 autocannon 的表里都只表现为"non2xx 很高"，
 * 这里一次性说清楚是哪一类。
 * ======================================================================== */

async function preflight() {
  let res;
  try {
    res = await fetch(TARGET_URL, {
      method: 'POST',
      headers: HEADERS,
      body: makeBody(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    die(
      [
        `连不上压测目标：${TARGET_URL}`,
        `  原因：${err.message}`,
        '',
        '  检查：服务起了吗？（npm run dev 或 docker compose up -d）',
        '        docker compose ps 看 api 是否 healthy',
      ].join('\n'),
    );
  }

  if (res.status === EXPECTED_STATUS) return;

  const detail = (await res.text().catch(() => '')).slice(0, 300);

  if (res.status === 401) {
    die(
      [
        '预检失败：401 未授权 —— 公钥无效。',
        '',
        `  用的是：${KEY.slice(0, 18)}…（来源：${KEY_SOURCE}）`,
        '',
        '  最常见原因：用的是 public schema 的钥匙，而压测打的是 bench schema。',
        '  两边的 project_keys 不是同一批 —— 从 bench 库里取：',
        '    docker exec argus-postgres-1 psql -U argus -d argus -t -c \\',
        '      "SELECT public_key FROM bench.project_keys;"',
        '',
        "  然后：$env:BENCH_KEY='argus_pub_...' 重跑",
      ].join('\n'),
    );
  }

  if (res.status === 404) {
    die(
      [
        `预检失败：404 —— 路径不存在：${TARGET_URL}`,
        '',
        batchSize > 1
          ? [
              '  批量模式打的是 /api/v1/error/batch，它是后加的端点。404 说明：',
              '    **容器还在跑旧镜像** —— 镜像构建了但容器没换。',
              '',
              '  修：',
              '    docker compose -f docker-compose.yml -f docker-compose.bench.yml \\',
              '      up -d --force-recreate api',
              '',
              '  验证镜像里有没有这个路由：',
              '    docker exec argus-api-1 node -e "const s=require(\'fs\')',
              '      .readFileSync(\'/app/dist/src/error-events/error-events.controller.js\',\'utf8\');',
              '      console.log(s.includes(\'error/batch\'))"',
            ].join('\n')
          : '  单条端点不该 404。检查 BENCH_URL 是否写错。',
      ].join('\n'),
    );
  }

  if (res.status === 413) {
    die(
      [
        `预检失败：413 —— 请求体 ${BODY_BYTES} 字节，超过服务端上限。`,
        '',
        '  Express 默认 100 KB。批量模式很容易踩到：',
        '  在 backend/src/main.ts 里把 json 的 limit 提到 1mb：',
        '     const app = await NestFactory.create<NestExpressApplication>(AppModule,',
        '       { bufferLogs: true, bodyParser: false });',
        "     app.useBodyParser('json', { limit: '1mb' });",
        '',
        `  或者把批量调小：--batch=${Math.max(1, Math.floor(batchSize * 0.8))}`,
      ].join('\n'),
    );
  }

  if (res.status === 429) {
    die(
      [
        '预检失败：429 被限流 —— 环境没固定。',
        '',
        '  限流默认 100 次/秒（注意：批量模式下守卫若按"请求"计费，',
        '  每个请求实际会放进 50 条事件 —— 见 backend 的 cost 改造）。',
        '',
        '  用压测覆盖层启动：',
        '    docker compose -f docker-compose.yml -f docker-compose.bench.yml up -d',
        '  （该文件把 RATE_LIMIT_ENABLED 设成了 false）',
        '',
        `  响应头 Retry-After：${res.headers.get('retry-after') ?? '(无)'}`,
      ].join('\n'),
    );
  }

  if (res.status === 400) {
    die(
      [
        `预检失败：400 参数校验不通过（期望 ${EXPECTED_STATUS}）。`,
        '',
        batchSize > 1
          ? `  批量模式最容易的错因：body 形状不是 { events: [...] }，或条数超过 ${MAX_BATCH}。`
          : '  单条模式的 body 形状与 DTO 对不上。',
        '',
        '  DTO 在 backend/src/error-events/dto/ingest-error.dto.ts，',
        '  改字段后要同步改本文件里的 buildEvent()。',
        '',
        `  服务端返回：${detail}`,
      ].join('\n'),
    );
  }

  die(`预检失败：HTTP ${res.status}（期望 ${EXPECTED_STATUS}）\n\n  返回：${detail}`);
}

/* ==========================================================================
 * ④ 跑一轮
 * ======================================================================== */

async function runOnce(connections, duration) {
  // 不传 callback 时 autocannon 返回 Promise；也不会渲染进度条，
  // 所以 stdout 可以干净地当 CSV 用。
  return autocannon({
    url: ORIGIN,
    connections,
    duration,
    timeout: 10,
    requests: [
      {
        method: 'POST',
        path: PATH,
        headers: HEADERS,
        // ⚠️ 必须写在 requests[] 里；写在顶层不生效（见文件头"已实测踩过的坑"）
        setupRequest(request) {
          request.body = makeBody();
          return request;
        },
      },
    ],
  });
}

/**
 * autocannon 的分位字段是 p2_5 / p50 / p75 / p90 / p97_5 / p99 —— **没有 p95**，
 * 也没有 `result['2xx']`。总数用 requests.total。
 */
function toRow(result, connections, duration) {
  const rps = result.requests.average;
  return {
    conn: connections,
    batch: batchSize,
    duration,
    rps,
    /** 关键指标：每秒真正上报的**事件**数（批量模式下 = rps × N） */
    eventsPerSec: rps * batchSize,
    total: result.requests.total,
    p50: result.latency.p50,
    p90: result.latency.p90,
    p97_5: result.latency.p97_5,
    p99: result.latency.p99,
    max: result.latency.max,
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    latAvg: result.latency.average,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/* ==========================================================================
 * ⑤ 主流程
 * ======================================================================== */

async function main() {
  process.stderr.write(
    [
      '',
      `目标        ${TARGET_URL}`,
      `模式        ${batchSize === 1 ? '单条（1 请求 = 1 事件）' : `批量（1 请求 = ${batchSize} 事件）`}`,
      `成功码      ${EXPECTED_STATUS}`,
      `公钥        ${KEY.slice(0, 18)}…（来源：${KEY_SOURCE}）`,
      `请求体      ${BODY_BYTES} 字节 / ${batchSize} 条 ≈ ${(BODY_BYTES / batchSize).toFixed(0)} 字节/条`,
      `会话口径    ${sessionMode}${
        sessionMode === 'unique'
          ? '（每事件新会话 → 测接口上限）'
          : '（全部共用一行 → 含 PG 行锁排队，仅作对照）'
      }`,
      `用户口径    ${userMode}${
        userMode === 'unique'
          ? '（每事件新用户 → UV / 影响用户数取上界）'
          : '（全部同一用户 → UV 恒为 1）'
      }`,
      `配置        ${CONNECTIONS} 并发 × ${DURATION} 秒 × ${ROUNDS} 轮`,
      `预热        ${WARMUP_SECONDS} 秒（结果丢弃）`,
      `输出        ${outPath ?? '(仅 stdout，不落盘)'}`,
      `node        ${process.version}`,
      '',
    ].join('\n'),
  );

  await preflight();
  process.stderr.write(`预检通过（${EXPECTED_STATUS}）\n`);

  process.stderr.write(
    [
      `预热中 ${WARMUP_SECONDS}s …`,
      `  （提示：批量模式下压测端每请求都要现造 ${batchSize} 条事件并序列化；`,
      '   同机压测时 autocannon 自己也可能吃满一个核 —— 见 SRS R-02）',
      '',
    ].join('\n'),
  );
  await runOnce(Math.min(CONNECTIONS, 10), WARMUP_SECONDS);

  const rows = [];

  /** CSV 行既打到 stdout（可管道/重定向），也攒起来给 --out 落盘 */
  const csvLines = [];
  const csv = (line) => {
    csvLines.push(line);
    process.stdout.write(line + '\n');
  };

  csv('conn,batch,duration_s,rps,events_s,total,p50_ms,p90_ms,p97_5_ms,p99_ms,max_ms,errors,timeouts,non2xx');

  for (let i = 1; i <= ROUNDS; i++) {
    process.stderr.write(`第 ${i}/${ROUNDS} 轮：${CONNECTIONS} 并发 × ${DURATION}s × ${batchSize} 条 …\n`);
    const row = toRow(await runOnce(CONNECTIONS, DURATION), CONNECTIONS, DURATION);
    rows.push(row);

    csv(
      [
        row.conn,
        row.batch,
        row.duration,
        row.rps.toFixed(1),
        row.eventsPerSec.toFixed(0),
        row.total,
        row.p50,
        row.p90,
        row.p97_5,
        row.p99,
        row.max,
        row.errors,
        row.timeouts,
        row.non2xx,
      ].join(','),
    );
  }

  // 中位数行（SRS §13.1："每配置至少 3 轮取中位数"）
  if (ROUNDS > 1) {
    csv(
      [
        `MEDIAN(${ROUNDS})`,
        batchSize,
        DURATION,
        median(rows.map((r) => r.rps)).toFixed(1),
        median(rows.map((r) => r.eventsPerSec)).toFixed(0),
        median(rows.map((r) => r.total)),
        median(rows.map((r) => r.p50)),
        median(rows.map((r) => r.p90)),
        median(rows.map((r) => r.p97_5)),
        median(rows.map((r) => r.p99)),
        median(rows.map((r) => r.max)),
        median(rows.map((r) => r.errors)),
        median(rows.map((r) => r.timeouts)),
        median(rows.map((r) => r.non2xx)),
      ].join(','),
    );
  }

  // ── 落盘（--out）───────────────────────────────────────────────────────
  // 只写 UTF-8（无 BOM）：PowerShell 5.1 的 `>` 会写成 UTF-16，Excel 打开是乱码。
  if (outPath !== null) {
    const abs = resolve(outPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, csvLines.join('\n') + '\n', 'utf8');
    process.stderr.write(`CSV 已写入 ${abs}（${csvLines.length} 行，UTF-8）\n`);
  }

  const rps = median(rows.map((r) => r.rps));
  const eventsPerSec = median(rows.map((r) => r.eventsPerSec));
  const latAvg = median(rows.map((r) => r.latAvg));

  // Little's Law 用的是**请求**延迟，所以只能和 rps 比，不能和 events/s 比。
  const little = latAvg > 0 ? CONNECTIONS / (latAvg / 1000) : 0;
  const ratio = little > 0 ? rps / little : 1;
  const verdict =
    ratio >= 0.9
      ? '实测 ≈ 理论：系统稳态，没有额外排队'
      : ratio >= 0.6
        ? '实测低于理论：部分请求在排队（查连接池 active / 限流 429 / 队列积压）'
        : '实测远低于理论：明显在排队，延迟不是主因';

  const lines = [
    '',
    '── 判读 ──────────────────────────────────────────────',
    `中位请求吞吐    ${rps.toFixed(0)} req/s`,
    `中位事件吞吐    ${eventsPerSec.toFixed(0)} events/s${
      batchSize > 1 ? `（= ${rps.toFixed(0)} × ${batchSize}）` : ''
    }`,
    `中位延迟        ${latAvg.toFixed(2)} ms/请求（p99 ${median(rows.map((r) => r.p99))} ms）`,
  ];

  if (batchSize > 1) {
    lines.push(`单事件延迟     ${(latAvg / batchSize).toFixed(2)} ms/条（摊薄后；这才是批量的收益来源）`);
  }

  lines.push(
    `Little's Law    ${CONNECTIONS} ÷ ${(latAvg / 1000).toFixed(4)}s ≈ ${little.toFixed(0)} req/s（实测/理论 = ${ratio.toFixed(2)}）`,
    `判读            ${verdict}`,
    `非 2xx          ${median(rows.map((r) => r.non2xx))}（应为 0；不为 0 先查 429/413/500）`,
    '',
    '报告里还要记：机器规格、api 容器 CPU 峰值（docker stats）、',
    'PG 连接数（pg_stat_activity）、以及"压测机与被测服务同机"这一限制。',
    '',
  );

  if (batchSize > 1) {
    lines.push(
      '⚠️ 与单条模式对比时：',
      '   · 两个模式的 CSV 不能混进同一张表，必须分开列并注明 batch',
      '   · 比较的是 events/s，不是 rps',
      '   · 批量模式下 sessions / affected_users 按**事件数**增长，跑完要清',
      '',
    );
  }

  process.stderr.write(lines.join('\n'));
}

main().catch((err) => {
  process.stderr.write(`\n✗ 压测中断：${err?.stack ?? String(err)}\n\n`);
  process.exitCode = 1;
});
