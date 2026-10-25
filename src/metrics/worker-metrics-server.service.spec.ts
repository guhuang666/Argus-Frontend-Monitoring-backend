import { jobAttemptsTotal } from './metrics.registry';
import { WorkerMetricsServerService } from './worker-metrics-server.service';

/**
 * worker 指标端点（M6-7 v2）。
 *
 * 这里**直接起真服务器**（`listen(0)` 拿随机空闲端口），因为要验的四件事
 * 全都是 HTTP 语义：状态码、content-type、404/405 的边界、registry 的文本输出。
 * mock 掉 http 只会把这段代码测成"我调了 createServer"。
 *
 * ⚠️ 刻意不调 `onModuleInit()`：它会执行 collectDefaultMetrics，在 jest
 * 里留下一个不会停的 interval。默认指标与本文件的断言无关。
 */
describe('WorkerMetricsServerService（M6-7 v2）', () => {
  let service: WorkerMetricsServerService;
  let baseUrl: string;

  beforeAll(async () => {
    service = new WorkerMetricsServerService();
    const port = await service.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    service.close();
  });

  it('GET /metrics 返回 200 + Prometheus 文本格式', async () => {
    // 先给一条真实的序列，避免断言依赖"别的测试文件是否跑过"
    jobAttemptsTotal.inc({ result: 'succeeded' }, 0);

    const res = await fetch(`${baseUrl}/metrics`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
  });

  it('归并侧的两个指标出现在输出里（这是 worker 单独开端口的全部理由）', async () => {
    jobAttemptsTotal.inc({ result: 'failed' }, 0);

    const text = await (await fetch(`${baseUrl}/metrics`)).text();

    expect(text).toContain('# TYPE argus_job_attempts_total counter');
    expect(text).toContain('argus_job_attempts_total{result="succeeded"}');
    expect(text).toContain('argus_job_attempts_total{result="failed"}');
    // DLQ 的 HELP 行始终存在（序列本身要等第一次失败才有）
    expect(text).toContain('# HELP argus_dlq_jobs_total');
  });

  it('别的路径一律 404（它不提供任何业务接口）', async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/v1/health/live`)).status).toBe(404);
  });

  it('非 GET/HEAD 返回 405', async () => {
    const res = await fetch(`${baseUrl}/metrics`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('带 query 的 /metrics 一样能抓（有些采集器会附带参数）', async () => {
    const res = await fetch(`${baseUrl}/metrics?format=prometheus`);
    expect(res.status).toBe(200);
  });

  it('重复 start 不会重复监听（返回同一个端口）', async () => {
    const port = await service.start(0);
    expect(`http://127.0.0.1:${port}`).toBe(baseUrl);
  });
});
