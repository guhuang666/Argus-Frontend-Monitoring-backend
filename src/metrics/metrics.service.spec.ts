import type { PrismaService } from '../prisma/prisma.service';
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
 * `MetricsService` 的构造参数里有 `PrismaService`（要查 projects 表），而它
 * `extends PrismaClient` —— 生成物是 TS 源码，jest 解析不了（同其它 spec 的说明）。
 * 本文件用一个只带 `project.findMany` 的假 Prisma，所以整条依赖链在模块层替换掉。
 */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
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
function buildService(
  behavior: {
    /** `projects where is_active` 返回什么 */
    projects?: Array<{ id: string }>;
    /** 每个项目 `getJobCounts` 返回什么；缺省 = 全 0 */
    countsById?: Record<string, Record<string, number>>;
    /** 这些项目的 getJobCounts 抛错 */
    failFor?: string[];
    /** 连项目列表都读不到 */
    projectsError?: Error;
  } = {},
) {
  const prisma = {
    project: {
      findMany: () =>
        behavior.projectsError === undefined
          ? Promise.resolve(behavior.projects ?? [])
          : Promise.reject(behavior.projectsError),
    },
  };

  const queues = {
    queueFor: (projectId: string) => ({
      getJobCounts: () =>
        behavior.failFor?.includes(projectId) === true
          ? Promise.reject(new Error('redis down'))
          : Promise.resolve(behavior.countsById?.[projectId] ?? {}),
    }),
  };

  return new MetricsService(
    queues as unknown as ProjectQueueService,
    prisma as unknown as PrismaService,
  );
}

describe('MetricsService（M6-7）', () => {
  it('recordIngest 按 project_id 累加', async () => {
    // 通过 service 的公开方法写，再读 registry —— 与真实链路一致
    const service = buildService();
    service.recordIngest('p-1');
    service.recordIngest('p-1');
    service.recordIngest('p-2');

    const text = await registry.metrics();

    expect(text).toContain('argus_ingest_events_total{project_id="p-1"} 2');
    expect(text).toContain('argus_ingest_events_total{project_id="p-2"} 1');
  });

  it('recordRejected 带 reason 标签', async () => {
    const service = buildService();

    service.recordRejected('p-1', 'rate_limit');

    expect(await registry.metrics()).toContain(
      'argus_ingest_rejected_total{project_id="p-1",reason="rate_limit"} 1',
    );
  });

  it('抓取时现场读队列长度，暴露四个状态', async () => {
    buildService({
      projects: [{ id: 'p-1' }],
      countsById: { 'p-1': { waiting: 7, active: 2, delayed: 1, failed: 0 } },
    });

    // registry.metrics() 会触发 Gauge 的 collect 回调 —— 正是 Prometheus 抓取时发生的事
    const text = await registry.metrics();

    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="waiting"} 7');
    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="active"} 2');
    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="delayed"} 1');
    expect(text).toContain('argus_queue_jobs{project_id="p-1",state="failed"} 0');
  });

  it('安静的项目也必须有序列：没有积压就是 0，而不是整条消失', async () => {
    buildService({ projects: [{ id: 'p-quiet' }] });

    const text = await registry.metrics();

    // 关键：这个项目从来没有上报过，队列里一条 job 都没有
    for (const state of ['waiting', 'active', 'delayed', 'failed']) {
      expect(text).toContain(`argus_queue_jobs{project_id="p-quiet",state="${state}"} 0`);
    }
  });

  it('多个项目：有数据的显示数字，没数据的显示 0', async () => {
    buildService({
      projects: [{ id: 'p-busy' }, { id: 'p-idle' }],
      countsById: { 'p-busy': { waiting: 3, active: 1 } },
    });

    const text = await registry.metrics();

    expect(text).toContain('argus_queue_jobs{project_id="p-busy",state="waiting"} 3');
    expect(text).toContain('argus_queue_jobs{project_id="p-idle",state="waiting"} 0');
    expect(text).toContain('argus_queue_jobs{project_id="p-idle",state="active"} 0');
  });

  it('单个项目读取失败：该项目仍暴露为 0，且不影响其它项目', async () => {
    buildService({
      projects: [{ id: 'p-broken' }, { id: 'p-ok' }],
      countsById: { 'p-ok': { waiting: 5 } },
      failFor: ['p-broken'],
    });

    const text = await registry.metrics();

    // 读失败也要有序列：否则 Grafana 上"项目消失"，比归零更容易被误读成"项目没了"
    expect(text).toContain('argus_queue_jobs{project_id="p-broken",state="waiting"} 0');
    expect(text).toContain('argus_queue_jobs{project_id="p-ok",state="waiting"} 5');
    // Redis 挂了，/metrics 依然要能返回（否则 Prometheus 判这个实例 down）
    expect(text).toContain('argus_ingest_events_total');
  });

  it('读项目列表失败时不抛异常，指标接口照常返回', async () => {
    buildService({ projectsError: new Error('pg down') });

    await expect(registry.metrics()).resolves.toContain('argus_ingest_events_total');
  });

  it('停用 / 删除的项目不再出现在指标里（每轮先 reset）', async () => {
    // 上一轮还有个 p-old
    buildService({ projects: [{ id: 'p-old' }] });
    expect(await registry.metrics()).toContain('project_id="p-old"');

    // 这一轮它被停用了 → 名单里没有它
    buildService({ projects: [{ id: 'p-new' }] });
    const text = await registry.metrics();

    expect(text).toContain('project_id="p-new"');
    expect(text).not.toContain('project_id="p-old"');
  });
});
