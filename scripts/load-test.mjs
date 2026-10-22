/**
 * M4-S8 最小闭环压测：A 项目打洪峰，看 B 项目有没有被拖累。
 *
 * ── 用法（在 backend 目录下）──────────────────────────────────────────────
 *   1. 先把 A 项目的限流调小，否则打不爆它：
 *      node -e "const{PrismaClient}=require('./dist/generated/prisma/client');const p=new PrismaClient();p.project.update({where:{id:'A的projectId'},data:{rateLimitPerSec:5}}).then(r=>{console.log(r.name,r.rateLimitPerSec);return p.$disconnect()})"
 *   2. node scripts/load-test.mjs
 *   3. 跑完把 rateLimitPerSec 改回 100
 *
 * ── 只看三个数 ────────────────────────────────────────────────────────────
 *   A 的 429 数（洪峰确实被限流了）
 *   B 的成功率（邻居没受影响）
 *   B 的 P95（邻居没变慢）
 */

const BASE = 'http://127.0.0.1:3000';

// A（打洪峰）：孤盟 / 项目2
const A_KEY = 'argus_pub_7dfb0bb35f94e0b16387672d2d7e1f02';
const A_PROJECT_ID = 'cbb56985-cba8-49f5-8f3e-539c7ee9220f';

// B（邻居）：张三公司 / 22 —— 与 A 属于不同组织，隔离演示更有说服力
const B_KEY = 'argus_pub_3e34fd1c320fec25c66984282cab0c6a';
const B_PROJECT_ID = '993af5b4-127f-4bdc-b93a-16c0f7eff311';

const CONCURRENCY = 50; // A 的并发
const SECONDS = 20; // 两个项目同时跑多久

/** 一条合法的上报体。event_id 必须每次不同，否则全被去重 */
function makeBody() {
  return JSON.stringify({
    event_id: crypto.randomUUID(),
    mechanism: 'onerror',
    type: 'TypeError',
    message: `load test ${Math.random()}`,
  });
}

/** 发一条，把结果记进 stat */
async function hit(key, stat) {
  const startedAt = performance.now();
  try {
    const res = await fetch(`${BASE}/api/v1/error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-argus-key': key },
      body: makeBody(),
    });
    await res.arrayBuffer(); // 不读响应体的话连接不会被复用，越跑越慢
    if (res.status === 201) {
      stat.ok += 1;
      stat.cost.push(performance.now() - startedAt);
    } else if (res.status === 429) {
      stat.limited += 1;
    } else {
      stat.other += 1;
    }
  } catch {
    stat.other += 1;
  }
}

/** 洪峰：50 个循环不停打 */
async function flood(key, stat, deadline) {
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) await hit(key, stat);
    }),
  );
}

/** 邻居：每 200ms 一条（5 条/秒） */
async function trickle(key, stat, deadline) {
  while (Date.now() < deadline) {
    await hit(key, stat);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function p95(cost) {
  if (cost.length === 0) return 0;
  const sorted = [...cost].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

const a = { ok: 0, limited: 0, other: 0, cost: [] };
const b = { ok: 0, limited: 0, other: 0, cost: [] };
const deadline = Date.now() + SECONDS * 1000;

console.log(`A（项目2，${A_PROJECT_ID.slice(0, 8)}）并发 ${CONCURRENCY} 打洪峰；`);
console.log(`B（22，${B_PROJECT_ID.slice(0, 8)}）同时每 200ms 一条；持续 ${SECONDS}s…`);
await Promise.all([flood(A_KEY, a, deadline), trickle(B_KEY, b, deadline)]);

const rate = (s) => `${((s.ok / (s.ok + s.limited + s.other)) * 100).toFixed(1)}%`;
console.log('');
console.log(`A（洪峰）  成功 ${a.ok}　429 ${a.limited}　其他 ${a.other}`);
console.log(`B（邻居）  成功 ${b.ok}　429 ${b.limited}　其他 ${b.other}　成功率 ${rate(b)}　P95 ${p95(b.cost).toFixed(1)}ms`);
console.log('');
console.log('A 大量 429 且 B 成功率接近 100% → 单项目洪峰没有影响邻居，M4 隔离成立。');
