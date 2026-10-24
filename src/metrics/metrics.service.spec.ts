import type { ProjectQueueService } from '../queue/project-queue.service';
import { MetricsService } from './metrics.service';
import { registry } from './metrics.registry';

/**
 * `MetricsService` 的构造函数参数里引用了 `ProjectQueueService`，
 * 而后者 import 了 `@nestjs/bullmq` / `bullmq` —— 这两个包是 ESM 形状，
 * jest 的 CJS 运行时解析不了（报 "Cannot use import statement outside a module"）。
 *
 * 本文件根本不需要真实队列，只需要类型对齐，所以在模块层替换成空壳。
 * 装饰器工厂返回一个空装饰器，`__decorate` 调它时不会报错。
 */
jest.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => undefined,
}));
jest.mock('bullmq', () => ({
  Queue: class Queue {},
}));

/**
 * 指标模块（M6-7）。
 *
 * 这里不 mock prom-client —— 要验的正是"我们注册的指标名/标签对不对"。
 * 断言直接读 `registry.metrics()` 的文本输出，等价于 Prometheus 实际看到的东西：
 * 如果标签拼错、类型不对，那段文本就会变，测试立刻失败。
 *
 * ⚠️ 不要调 `onModuleInit()`：它会启动默认指标采集的定时器，在 jest 里
 * 留下一个不会停的 interval（进程退出时报警告）。默认指标由 prom-client
 * 自己保证，不需要在本文件验证。
 */
function buildService(entries: Array<{ projectId: string; counts: Record<string, number> }>) {
  const queues = {
    entries: () =>
      entries.map(({ projectId, counts }) => ({
        projectId,
        queue: { getJobCounts: () => Promise.resolve(counts) },
      })),
  };

  return new MetricsService(queues as unknown as ProjectQueueService);
}

describe('MetricsService（M6-7 最小版）', () => {
  it('recordIngest 按 project_id 累加', async () => {
    const service = buildService([]);

    service.recordIngest('p-1');
    service.recordIngest('p-1');
    service.recordIngest('p-2');

    const text = await registry.metrics();

    expect(text).toContain('argus_ingest_events_total{project_id="p-1"} 2');
    expect(text).toContain('argus_ingest_events_total{project_id="p-2"} 1');
  });

  it('recordRejected 带 reason 标签', async () => {
    const service = buildService([]);

    service.recordRejected('p-1', 'rate_limit');

    const text = await registry.metrics();

    expect(text).toContain('argus_ingest_rejected_total{project_id="p-1",reason="rate_limit"} 1');
  });

  it('抓取时现场读队列长度，并暴露四个状态', async () => {
    const service = buildService([
      { projectId: 'p-1', counts: { waiting: 7, active: 2, delayed: 1, failed: 0 } },
    ]);
    // 拿住实例，避免 eslint 认为它没用
    expect(service).toBeDefined();

    // registry.metrics() 会触发 Gauge 的 collect 回调 —— 这正是 Prometheus 抓取时发生的事
    const text = await registry.metrics();

    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="waiting"} 7');
    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="active"} 2');
    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="delayed"} 1');
    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="failed"} 0');
  });

  it('队列查询失败时不影响其它指标（collect 必须吞异常）', async () => {
    const queues = {
      entries: () => [
        {
          projectId: 'p-broken',
          queue: {
            getJobCounts: () => Promise.reject(new Error('redis down')),
          },
        },
      ],
    };
    new MetricsService(queues as unknown as ProjectQueueService);

    // 关键断言：Redis 挂了，/metrics 依然能返回内容（否则 Prometheus 会判 down）
    await expect(registry.metrics()).resolves.toContain('argus_ingest_events_total');
  });
});
