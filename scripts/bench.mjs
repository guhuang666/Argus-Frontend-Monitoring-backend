#!/usr/bin/env node
/**
 * 上报接口压测脚手架（M7-T4）
 *
 *   node --env-file=.env scripts/bench.mjs [并发] [秒数] [轮数] [--out <csv>] [--session u|f] [--user u|f]
 *
 * 例：
 *   node --env-file=.env scripts/bench.mjs                              # 50 并发 / 30 秒 / 3 轮
 *   node --env-file=.env scripts/bench.mjs 5 3 1                        # 冒烟：先确认通路
 *   node --env-file=.env scripts/bench.mjs 200 60 3                     # 加压找拐点
 *   node --env-file=.env scripts/bench.mjs 200 60 3 --session=fixed --user=fixed  # 旧口径对照组
 *   node --env-file=.env scripts/bench.mjs 50 20 3 --out bench/c50.csv  # 顺便落盘
 *
 * ── 为什么不用 autocannon 命令行直接打 ──────────────────────────────────
 * 命令行版做不到这三件事，而这个项目的压测必须做：
 *   ① 每条事件的 event_id 必须唯一（否则除第一条外全走 duplicate 分支，
 *      测的不是正常写入路径）——用 requests[].setupRequest 每请求换 ID
 *   ② 需要一个"开跑前的预检"：公钥错 / 限流没关 / 服务没起，在压测表里
 *      都只表现为"一堆非 2xx"，不预检就得事后猜
 *   ③ 3 轮取中位数并输出 CSV —— SRS §13.1 明确要求
 *
 * ── ⚠️ 两个已实测踩过的坑（别改回去）──────────────────────────────────
 *   · `idReplacement: true` + body 里写 `[<id>]`：本环境下**全部请求挂死**
 *     （sent>0 但 total=0、无响应、无错误）。怀疑是替换后 Content-Length
 *     与实体长度不一致，服务端一直等剩余字节。改用 setupRequest。
 *   · 顶层 `setupRequest`（写在 autocannon({...}) 里，不在 requests[] 内）：
 *     **不生效** —— 实测 1001 个请求全部 non-2xx（没带 body → 400）。
 *     必须写在 `requests: [{ setupRequest }]` 里。
 *
 * ── 公钥从哪来 ──────────────────────────────────────────────────────────
 * 优先 BENCH_KEY，其次 ARGUS_PUBLIC_KEY（backend/.env 里就有）。
 *   ⚠️ .env 里的 ARGUS_PUBLIC_KEY 是 seed 生成的"默认项目"钥匙；重建过数据库
 *   （down -v / migrate reset）后它就不存在了，压测会全线 401 —— 所以有预检。
 *   临时换一把不用改 .env：
 *     $env:BENCH_KEY='argus_pub_...'
 *
 * ── 环境要求（否则数字不可比）─────────────────────────────────────────
 *   docker compose -f docker-compose.yml -f docker-compose.bench.yml up -d
 *   → api 固定 2 核、RATE_LIMIT_ENABLED=false、LOG_LEVEL=warn
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import autocannon from 'autocannon';

/* ==========================================================================
 * ① 参数与配置
 * ======================================================================== */

const TARGET_URL = process.env.BENCH_URL ?? 'http://localhost:3000/api/v1/error';

/**
 * 公钥解析：BENCH_KEY > ARGUS_PUBLIC_KEY，并记录来源。
 *
 * 用 `||` 而不是 `??`：`??` 只对 null/undefined 回退。一旦 BENCH_KEY 被设成空串
 * （PowerShell: `$env:BENCH_KEY=''`），`??` 会直接返回空串，永远不去看
 * ARGUS_PUBLIC_KEY —— 表现是"明明 .env 里有钥匙，脚本却说缺少公钥"。
 *
 * 为什么要把来源打印出来：shell 环境变量**优先于** `--env-file`
 * （Node 的 --env-file 不覆盖已存在的变量），而这件事是完全静默的。
 * 不打印来源，就永远查不出"我改了 .env 为什么没生效"。
 */
function resolveKey() {
  for (const name of ['BENCH_KEY', 'ARGUS_PUBLIC_KEY']) {
    const value = process.env[name]?.trim();
    if (value) return { key: value, source: name };
  }
  return { key: '', source: null };
}

const { key: KEY, source: KEY_SOURCE } = resolveKey();

// ── 参数：位置参数 [并发] [秒数] [轮数]，外加 --out <csv> ──────────────────
const argv = process.argv.slice(2);
const positional = [];
let outPath = null;
/** 会话口径，见 buildBody 上方注释。默认 unique：测真实上限 */
let sessionMode = 'unique';
/** 用户口径，见 buildBody 上方注释。默认 unique：测 UV / 影响用户数的上界 */
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

const parsed = new URL(TARGET_URL);
const ORIGIN = parsed.origin;
const PATH = parsed.pathname;

if (!Number.isInteger(CONNECTIONS) || CONNECTIONS < 1) die(`并发数必须是正整数，收到 ${CONNECTIONS}`);
if (!Number.isInteger(DURATION) || DURATION < 1) die(`时长必须是正整数秒，收到 ${DURATION}`);
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) die(`轮数必须是正整数，收到 ${ROUNDS}`);
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
 * ② 请求体：一条"像真的"错误事件
 *
 * 字段与上限严格对齐 backend/src/error-events/dto/ingest-error.dto.ts：
 *   event_id 1~128   mechanism 三选一   type 1~128   message 1~2000
 *   stack ≤64KB      url ≤2048        user_agent ≤512
 *   source ≤512      release ≤100     environment ≤50    user.id 1~100
 *
 * 为什么字段要填全：少填可选字段会让 JSON.parse 的成本低于真实场景，
 * 测出来的吞吐会虚高。这里按 SDK 实际会发的形状来。
 * 实测体积约 1.4 KB/条（SRS §13.1 假设 ~800B/条，报告里按实测字节数写）。
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
 * 生成一条事件。event_id 每次不同（否则全被 event_id 主键去重），
 * 其余字段固定 —— 固定才能让每请求的 JSON.parse 成本可比。
 *
 * ── session_id 的两种口径（--session）──────────────────────────────────
 * unique（默认）：session_id 由 event_id 派生 → 每请求一个全新会话。
 *   sessions 表每次 INSERT 新行，不再有「同一行」的行锁竞争。
 *   这是**上限口径**：真实流量里一个会话通常带多条错误，真实值会略低于它。
 *   ⚠️ 代价：sessions 按请求数增长，60s 一轮可能多出十几万行 ——
 *   多轮压测前要 truncate sessions（或换库），否则后几轮压的是"更大的表"。
 *
 * fixed：所有请求共用 sess-bench-0001 → 那一行被反复 UPSERT。
 *   高并发下 PG 会对同一行加行锁，排队时间被算进 P99，
 *   于是测到的不是接口上限，而是**同一行的锁排队上限**。
 *   保留它只为和旧数据做对照，不要拿它出结论。
 *
 * ⚠️ 两种口径的 CSV 不能放进同一张对比表。
 *
 * ── user.id 的两种口径（--user）────────────────────────────────────────
 * unique（默认）：u_<event_id> → 每请求一个新用户。
 *   影响三处统计口径：error_groups.users_seen ≈ times_seen、
 *   affected_users 每事件一行、UV 与事件数 1:1 —— 这是**上界**。
 *   ⚠️ affected_users 也会按请求数增长，压测间要一起清。
 *
 * fixed：全部 u_bench_0001 → UV 去重恒定，接近"单个用户连续报错"。
 *
 * 要完全复现改动前的请求体：--session=fixed --user=fixed
 */
const FIXED_SESSION_ID = 'sess-bench-0001';
const FIXED_USER_ID = 'u_bench_0001';

function buildBody(eventId) {
  // 两个 ID 都从 event_id 派生而非另调 randomUUID：省一次 CSPRNG，
  // 且「同一请求的 event_id / session_id / user_id 一一对应」，对账时可直接互换。
  // 长度：sess-<uuid> = 41、u_<uuid> = 38，均 < 各自列宽的 100。
  const sessionId = sessionMode === 'fixed' ? FIXED_SESSION_ID : `sess-${eventId}`;
  const userId = userMode === 'fixed' ? FIXED_USER_ID : `u_${eventId}`;
  return JSON.stringify({
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
  });
}

const BODY_BYTES = Buffer.byteLength(buildBody('00000000-0000-0000-0000-000000000000'), 'utf8');

/* ==========================================================================
 * ③ 预检：一条请求先确认"能通"
 *
 * 401 / 429 / 400 / 连接失败在 autocannon 的表里都只表现为"non2xx 很高"，
 * 这里一次性说清楚是哪一类。
 * ======================================================================== */

async function preflight() {
  let res;
  try {
    res = await fetch(TARGET_URL, {
      method: 'POST',
      headers: HEADERS,
      body: buildBody(randomUUID()),
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

  if (res.status === 201) return;

  const detail = (await res.text().catch(() => '')).slice(0, 300);

  if (res.status === 401) {
    die(
      [
        '预检失败：401 未授权 —— 公钥无效。',
        '',
        `  用的是：${KEY.slice(0, 18)}…`,
        '',
        '  最常见原因：.env 里的 ARGUS_PUBLIC_KEY 是旧 seed 生成的钥匙，',
        '  数据库重建过（down -v / migrate reset / 换库）之后那把钥匙已不存在。',
        '',
        '  解决：从看板复制当前项目的公钥，或直接指定',
        "    $env:BENCH_KEY='argus_pub_...'  然后重跑",
      ].join('\n'),
    );
  }

  if (res.status === 429) {
    die(
      [
        '预检失败：429 被限流 —— 环境没固定。',
        '',
        '  限流默认 100 次/秒，压测会立刻打满。用压测覆盖层启动：',
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
        '预检失败：400 参数校验不通过 —— 压测载荷和 DTO 对不上了。',
        '',
        '  DTO 在 backend/src/error-events/dto/ingest-error.dto.ts，',
        '  改字段后要同步改本文件里的 buildBody()。',
        '',
        `  服务端返回：${detail}`,
      ].join('\n'),
    );
  }

  if (res.status === 404) die(`预检失败：404 —— 路径不对。当前 URL：${TARGET_URL}`);

  die(`预检失败：HTTP ${res.status}\n\n  返回：${detail}`);
}

/* ==========================================================================
 * ④ 跑一轮
 * ======================================================================== */

async function runOnce(connections, duration) {
  // 不传 callback 时 autocannon 返回 Promise；也不会渲染进度条（那是 track() 的行为），
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
          request.body = buildBody(randomUUID());
          return request;
        },
      },
    ],
  });
}

/**
 * autocannon 的分位字段是 p2_5 / p50 / p75 / p90 / p97_5 / p99 —— **没有 p95**，
 * 也没有 `result['2xx']`。总数用 requests.total（实测存在且准确）。
 */
function toRow(result, connections, duration) {
  return {
    conn: connections,
    duration,
    rps: result.requests.average,
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
      `公钥        ${KEY.slice(0, 18)}…（来源：${KEY_SOURCE}）`,
      `请求体      ${BODY_BYTES} 字节 / 1 条事件（当前接口是单条上报，故 req/s = events/s）`,
      `会话口径    ${sessionMode}${
        sessionMode === 'unique'
          ? '（每请求新会话 → 测接口上限）'
          : '（全部共用一行 → 含 PG 行锁排队，仅作对照）'
      }`,
      `用户口径    ${userMode}${
        userMode === 'unique'
          ? '（每请求新用户 → UV / 影响用户数取上界）'
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
  process.stderr.write('预检通过（201）\n');

  process.stderr.write(`预热中 ${WARMUP_SECONDS}s …\n`);
  await runOnce(Math.min(CONNECTIONS, 10), WARMUP_SECONDS);

  const rows = [];

  /** CSV 行既打到 stdout（可管道/重定向），也攒起来给 --out 落盘 */
  const csvLines = [];
  const csv = (line) => {
    csvLines.push(line);
    process.stdout.write(line + '\n');
  };

  csv('conn,duration_s,rps,total,p50_ms,p90_ms,p97_5_ms,p99_ms,max_ms,errors,timeouts,non2xx');

  for (let i = 1; i <= ROUNDS; i++) {
    process.stderr.write(`第 ${i}/${ROUNDS} 轮：${CONNECTIONS} 并发 × ${DURATION}s …\n`);
    const row = toRow(await runOnce(CONNECTIONS, DURATION), CONNECTIONS, DURATION);
    rows.push(row);

    csv(
      [row.conn, row.duration, row.rps.toFixed(1), row.total, row.p50, row.p90, row.p97_5, row.p99, row.max, row.errors, row.timeouts, row.non2xx].join(','),
    );
  }

  // 中位数行（SRS §13.1："每配置至少 3 轮取中位数"）
  if (ROUNDS > 1) {
    csv(
      [
        `MEDIAN(${ROUNDS})`, DURATION,
        median(rows.map((r) => r.rps)).toFixed(1),
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
  const latAvg = median(rows.map((r) => r.latAvg));
  const little = latAvg > 0 ? CONNECTIONS / (latAvg / 1000) : 0;

  // 实测 / Little's Law 的比值，是判断"有没有额外排队"的快捷指标：
  //   ≈1      稳态：延迟就是真延迟
  //   0.6~0.9 部分请求在排队（连接池、限流、队列）
  //   <0.6    明显排队：延迟不是主因，去查下游
  const ratio = little > 0 ? rps / little : 1;
  const verdict =
    ratio >= 0.9
      ? '实测 ≈ 理论：系统稳态，没有额外排队'
      : ratio >= 0.6
        ? '实测低于理论：部分请求在排队（查连接池 active / 限流 429 / 队列积压）'
        : '实测远低于理论：明显在排队，延迟不是主因';

  process.stderr.write(
    [
      '',
      '── 判读 ──────────────────────────────────────────────',
      `中位吞吐        ${rps.toFixed(0)} req/s（= events/s，单条模式）`,
      `中位延迟        ${latAvg.toFixed(2)} ms（p99 ${median(rows.map((r) => r.p99))} ms）`,
      `Little's Law    ${CONNECTIONS} ÷ ${(latAvg / 1000).toFixed(4)}s ≈ ${little.toFixed(0)} req/s（实测/理论 = ${ratio.toFixed(2)}）`,
      `判读            ${verdict}`,
      `非 2xx          ${median(rows.map((r) => r.non2xx))}（应为 0；不为 0 先查 429/500）`,
      '',
      '报告里还要记：机器规格、api 容器 CPU 峰值（docker stats）、',
      'PG 连接数（pg_stat_activity）、以及"压测机与被测服务同机"这一限制。',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`\n✗ 压测中断：${err?.stack ?? String(err)}\n\n`);
  process.exitCode = 1;
});
