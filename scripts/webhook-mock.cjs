#!/usr/bin/env node
/**
 * Webhook 模拟接收器（M6-4 验收用）。
 *
 * 为什么需要它：告警的最后一公里是"真的发出去一次"，而真飞书机器人要外网、
 * 要建群、还会把测试消息发给同事。这个脚本在本机起一个 HTTP 服务，
 * 把收到的 payload 原样打出来 —— 既能验三种渠道的形状，也能验重试次数。
 *
 * 用法（在 backend 目录下）：
 *   node scripts/webhook-mock.cjs                 # 监听 4001，全部返回 200
 *   node scripts/webhook-mock.cjs --fail 2        # 前 2 次返回 500，第 3 次成功（验证重试）
 *   WEBHOOK_MOCK_PORT=4002 node scripts/webhook-mock.cjs
 *
 * 然后把规则的 webhook 地址填成 http://127.0.0.1:4001/hook。
 *
 * ── 为什么成功时回 {"code":0} ──────────────────────────────────────────
 * 投递器不只看 HTTP 状态码，还看飞书/钉钉风格的 code/errcode。
 * 回一段不含这两个字段的 JSON（或纯文本）也算成功，但回 {"code":0}
 * 更接近真实响应的形状，能顺带验证解析逻辑没把成功误判成失败。
 */
const http = require('node:http');

const port = Number(process.env.WEBHOOK_MOCK_PORT ?? 4001);

const failIndex = process.argv.indexOf('--fail');
const failFirst =
  failIndex === -1 ? Number(process.env.WEBHOOK_MOCK_FAIL ?? 0) : Number(process.argv[failIndex + 1] ?? 0);

let seq = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    seq += 1;
    const fail = seq <= failFirst;

    console.log(`\n#${seq} ${req.method} ${req.url} → ${fail ? 500 : 200}`);

    // 尽量格式化；不是 JSON 就原样打出来（比如有人手写了个 text/plain 的假服务）
    try {
      console.log(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      console.log(body);
    }

    res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
    res.end(fail ? '{"error":"mock: forced failure"}' : '{"code":0}');
  });
});

server.listen(port, () => {
  console.log(`webhook-mock 监听 http://127.0.0.1:${port}/hook`);
  console.log(
    failFirst > 0
      ? `前 ${failFirst} 次请求返回 500（用来验证重试），之后返回 200`
      : '所有请求返回 200',
  );
});
