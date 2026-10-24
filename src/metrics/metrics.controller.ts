import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { registry } from './metrics.registry';

/**
 * 指标端点（M6-7）。
 *
 *   GET /metrics        ← 注意：没有 /api/v1 前缀
 *
 * ── 为什么不带 /api/v1 ──────────────────────────────────────────────────
 * 这个接口不是给业务调用方的，是给 Prometheus 抓的。业界默认就是根路径下
 * 的 `/metrics`，所有现成的抓取配置、Grafana 模板、教程都默认这个地址；
 * 为了"统一前缀"把它挪进 api/v1，等于以后每接一个工具都要多配一行。
 *
 * ── 为什么不加鉴权 ──────────────────────────────────────────────────────
 * Prometheus 抓取不会带 JWT（和健康检查同一个理由）。所以它必须：
 *   ① 只读，且不含任何密钥（指标里只有计数和标签，没有 webhook / 连接串）
 *   ② 部署时只绑内网/本机，绝不直接暴露到公网
 * 第 ② 条是部署纪律，不是代码能保证的 —— 写在这里是为了别忘。
 */
@Controller()
export class MetricsController {
  @Get('metrics')
  async metrics(@Res() res: Response): Promise<void> {
    // contentType 是 prom-client 提供的标准值：
    // text/plain; version=0.0.4; charset=utf-8
    // 手写字符串容易漏掉 version，某些抓取器会因此解析失败
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}
