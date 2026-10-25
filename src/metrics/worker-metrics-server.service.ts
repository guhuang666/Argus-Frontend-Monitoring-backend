import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectDefaultMetrics } from 'prom-client';
import { jobAttemptsTotal, registry } from './metrics.registry';

/** 默认端口。用 9464 是因为它不与 API 的 3000 / 看板的 5173 冲突，也好记 */
const DEFAULT_PORT = 9464;

/** 只在这一个路径上输出，其余一律 404 */
const METRICS_PATH = '/metrics';

/**
 * worker 进程的指标端点（M6-7 v2）。
 *
 * ── 为什么 worker 需要自己的 HTTP 端口 ───────────────────────────────────
 * 归并相关的指标（`argus_job_attempts_total` / `argus_dlq_jobs_total`）是在
 * **worker 进程内存里**累加的，API 进程的 registry 里根本没有这些序列。
 * 不单独暴露的话，这两个数字永远不会出现在 Prometheus 里 ——
 * "重试率""DLQ 有没有涨"这些最该被盯的指标就成一个盲区。
 *
 * ── 为什么不并入 API 的 /metrics ────────────────────────────────────────
 * 两个进程的内存不互通，跨进程读只能靠 Redis 或数据库中转，那等于给指标
 * 增加一条"可能失败的中转链路"。各暴露各的，让 Prometheus 用两个 target
 * 抓取（它天生就这么用），是最简单也最不容易错的做法。
 *
 * ── 一个刻意的取舍：端口起不来不 crash ──────────────────────────────────
 * 指标是**旁路能力**：端口被占用 / 没有监听权限时，worker 仍然应该正常消费
 * 队列。所以这里只 warn，绝不退出进程 —— "监控端点挂了"不该升级成
 * "业务停摆"。
 */
@Injectable()
export class WorkerMetricsServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerMetricsServerService.name);
  private server?: Server;
  /** 实际监听到的端口（`start(0)` 时由系统分配，测试要用它） */
  private boundPort?: number;

  async onModuleInit(): Promise<void> {
    // worker 进程自己的 CPU / 内存 / 事件循环延迟：与 API 侧同名，
    // Prometheus 靠 target 的 instance 标签区分，不会互相覆盖
    collectDefaultMetrics({ register: registry });

    // 预置两条 0 值序列。prom-client 的 Counter 带标签时**没有 inc 过就完全不出现**，
    // 于是 worker 刚起来、还没处理过 job 时，`argus_job_attempts_total` 一个字都没有——
    // 抓取方看到的不是"0 次尝试"，而是"这条序列不存在"（rate() 直接断线）。
    // 主动置 0 之后，从第一秒起就有序列。
    jobAttemptsTotal.inc({ result: 'succeeded' }, 0);
    jobAttemptsTotal.inc({ result: 'failed' }, 0);

    try {
      await this.start();
      this.logger.log(
        `worker 指标端点已就绪 → http://127.0.0.1:${String(this.boundPort)}${METRICS_PATH}`,
      );
    } catch (err) {
      this.logger.warn(
        `worker 指标端点启动失败（worker 继续消费，只是 Prometheus 看不到本进程）：${String(err)}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.close();
  }

  /**
   * 起监听。抽成独立方法（而不是塞在 onModuleInit 里）是为了让测试能
   * 用 `start(0)` 拿一个随机空闲端口，且不触发 collectDefaultMetrics 的定时器。
   */
  async start(port: number = resolvePort()): Promise<number> {
    if (this.server !== undefined && this.boundPort !== undefined) {
      return this.boundPort;
    }

    const server = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        this.server = undefined;
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    });

    // 监听成功之后仍然要挂一个常驻的 error 监听：
    // 否则运行时出错（比如底层 socket 异常）会触发未处理的 'error' 事件 → 进程崩
    server.on('error', (err: Error) => {
      this.logger.warn(`worker 指标端点运行异常：${err.message}`);
    });

    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    return this.boundPort;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.boundPort = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 去掉 query：/metrics?x=1 也应当能抓（有些采集器会带参数）
    const path = (req.url ?? '').split('?')[0];

    if (path !== METRICS_PATH) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('not found\n');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, HEAD');
      res.end();
      return;
    }

    try {
      const text = await registry.metrics();
      res.statusCode = 200;
      // contentType 是 prom-client 提供的标准值（text/plain; version=0.0.4）
      res.setHeader('content-type', registry.contentType);
      res.end(req.method === 'HEAD' ? undefined : text);
    } catch (err) {
      // 与 API 侧同一条纪律：指标接口自己不能变成故障源。
      // 返回 500 至少能让抓取方看到"这个 target 有问题"，而不是连接超时
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(`metrics error: ${String(err)}\n`);
    }
  }
}

/** `WORKER_METRICS_PORT` 非法时回默认值，而不是监听 NaN 端口 */
function resolvePort(): number {
  const raw = process.env.WORKER_METRICS_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}
