import type { Queue } from 'bullmq';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthService, type RedisProbe } from './health.service';

/**
 * @nestjs/bullmq v12 是纯 ESM 包（dist 里就是 import/export），jest 用 CJS
 * 加载会在 require 阶段直接抛 "Must use import to load ES Module"。
 * 本测试只需要 @InjectQueue 这个装饰器工厂，而装饰器在手动 `new` 出来的
 * 实例上本来就不起作用（DI 是容器的事），换成空实现即可。
 * 同 error-events.service.spec.ts 里的处理。
 */
jest.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => undefined,
}));

/**
 * jest 加载不了 generated/prisma/client.ts：它是 prisma-client 生成器产出的
 * TS 源码，内部用 `./internal/class.js` 这种"指向 .ts 源文件"的写法，jest 的
 * 解析器不认。health.service.ts 把 PrismaService 当值引入（构造参数要用它做
 * DI token），于是整条链会被拉进来 —— 所以必须在这里把模块替换掉。
 *
 * 只需要 PrismaClient 存在：prisma.service.ts 里是
 * `class PrismaService extends PrismaClient`，缺了它会在加载阶段
 * "Class extends value undefined"。
 */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
}));

interface RedisCalls {
  connect: number;
  ping: number;
  disconnect: number;
  errorListeners: number;
}

interface HarnessOptions {
  /** PG 检查。默认成功；传 reject 的函数即模拟 PG 挂掉 */
  prisma?: () => Promise<unknown>;
  /** 队列检查。默认成功；传 never-resolving 即模拟超时 */
  queue?: () => Promise<unknown>;
  redisConnect?: () => Promise<void>;
  redisPing?: () => Promise<string>;
  /** 模拟 ioredis 在连接失败时先 emit 的 'error'（真正的失败原因在这里） */
  redisError?: Error;
  /** 单测里压到几十毫秒，否则"等超时"的用例会把测试拖成好几秒 */
  timeoutMs?: number;
}

/**
 * 手动装配一个 HealthService。
 *
 * 不走 Nest 的 Test.createTestingModule：本 service 的四个依赖全是接口级契约
 * （Prisma 的一方法、队列的二方法、Redis 的四方法），手写假对象比配
 * providers 更直观，也不会因为将来加一个无关依赖就整篇测试报注入错误。
 */
function harness(options: HarnessOptions = {}): {
  service: HealthService;
  redisCalls: RedisCalls;
} {
  const prisma = {
    // 用 Promise.resolve 而不是 async 箭头：里面没有 await，
    // 写成 async 会被 @typescript-eslint/require-await 判为噪音
    $queryRaw: () => (options.prisma ?? (() => Promise.resolve([{ ok: 1 }])))(),
  };
  const queue = {
    getJobCounts: () =>
      (options.queue ?? (() => Promise.resolve({ wait: 0 })))(),
  };

  const redisCalls: RedisCalls = {
    connect: 0,
    ping: 0,
    disconnect: 0,
    errorListeners: 0,
  };

  // 记录 service 挂上的 'error' 监听者：真人 ioredis 的底层失败原因只从这里出来
  let errorListener: ((err: Error) => void) | undefined;

  const factory = (): RedisProbe => ({
    connect: async () => {
      redisCalls.connect += 1;
      // 真实顺序是"先 emit error，再 reject connect()"
      if (options.redisError !== undefined) errorListener?.(options.redisError);
      await options.redisConnect?.();
    },
    ping: async () => {
      redisCalls.ping += 1;
      return options.redisPing === undefined ? 'PONG' : options.redisPing();
    },
    disconnect: () => {
      redisCalls.disconnect += 1;
    },
    on: (_event, listener) => {
      redisCalls.errorListeners += 1;
      errorListener = listener;
      return undefined;
    },
  });

  const service = new HealthService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue,
    factory,
    { timeoutMs: options.timeoutMs ?? 50 },
  );

  return { service, redisCalls };
}

describe('HealthService', () => {
  describe('live（存活探针）', () => {
    it('永远 ok，而且一条依赖都不碰', () => {
      const { service, redisCalls } = harness({
        prisma: () => Promise.reject(new Error('PG 挂了')),
        queue: () => Promise.reject(new Error('队列挂了')),
        redisConnect: () => Promise.reject(new Error('Redis 挂了')),
      });

      const result = service.checkLiveness();

      expect(result.status).toBe('ok');
      expect(result.pid).toBe(process.pid);
      expect(typeof result.uptimeSec).toBe('number');
      // 这条断言是 live/ready 拆分的核心：依赖全挂，live 也不许去查它们，
      // 否则 Redis 一抖，编排系统就会重启所有 API 实例（而重启救不了 Redis）
      expect(redisCalls.connect).toBe(0);
    });
  });

  describe('ready（就绪探针）', () => {
    it('三项全通 → status=ok，failed 为空', async () => {
      const { service } = harness();

      const result = await service.checkReadiness();

      expect(result.status).toBe('ok');
      expect(result.failed).toEqual([]);
      expect(result.checks.pg.ok).toBe(true);
      expect(result.checks.redis.ok).toBe(true);
      expect(result.checks.queue.ok).toBe(true);
      expect(result.checks.pg.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('PG 不通 → 只有 pg 失败，body 里写明哪一项', async () => {
      const { service } = harness({
        prisma: () =>
          Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
      });

      const result = await service.checkReadiness();

      expect(result.status).toBe('error');
      expect(result.failed).toEqual(['pg']);
      expect(result.checks.pg.error).toContain('ECONNREFUSED');
      // 其余两项不受牵连：这正是"写明哪项失败"要提供的信息
      expect(result.checks.redis.ok).toBe(true);
      expect(result.checks.queue.ok).toBe(true);
    });

    it('Redis 不通 → redis 失败，而且客户端一定被断开（不泄漏连接）', async () => {
      const { service, redisCalls } = harness({
        redisConnect: () =>
          Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
      });

      const result = await service.checkReadiness();

      expect(result.failed).toEqual(['redis']);
      expect(result.checks.redis.error).toContain('ECONNREFUSED');
      // 失败路径也必须 disconnect：否则每 10 秒漏一条连接，一天就是几千条
      expect(redisCalls.disconnect).toBe(1);
    });

    it('Redis 回了一个意外值（对面不是我们以为的那个 Redis）→ 判失败', async () => {
      const { service } = harness({
        redisPing: () => Promise.resolve('PONG-but-not-really'),
      });

      const result = await service.checkReadiness();

      expect(result.failed).toEqual(['redis']);
      expect(result.checks.redis.error).toContain('意外的值');
    });

    it('底层连接错误优先报 error 事件里那条（connect 的 rejection 只有一句废话）', async () => {
      const { service } = harness({
        // 真人 ioredis 的表现：error 事件带 ECONNREFUSED，connect() 只回 "Connection is closed."
        redisError: new Error('connect ECONNREFUSED 127.0.0.1:6399'),
        redisConnect: () => Promise.reject(new Error('Connection is closed.')),
      });

      const result = await service.checkReadiness();

      expect(result.failed).toEqual(['redis']);
      // 带着地址的原因才有排查价值；只报 "Connection is closed." 等于没报
      expect(result.checks.redis.error).toContain('ECONNREFUSED');
      expect(result.checks.redis.error).toContain('6399');
    });

    it('Redis 客户端挂了 error 监听（否则未捕获的 error 事件能崩掉进程）', async () => {
      const { service, redisCalls } = harness();

      await service.checkReadiness();

      expect(redisCalls.errorListeners).toBeGreaterThanOrEqual(1);
    });

    it('队列检查超时 → 判失败并说明超时，不会一直挂着', async () => {
      const { service } = harness({
        // 永远不 resolve：模拟"TCP 能连上但不回包"的半死状态
        queue: () => new Promise<never>(() => undefined),
        timeoutMs: 20,
      });

      const startedAt = Date.now();
      const result = await service.checkReadiness();

      expect(result.failed).toEqual(['queue']);
      expect(result.checks.queue.error).toContain('超时');
      expect(result.checks.queue.durationMs).toBeGreaterThanOrEqual(20);
      // 上限给得宽松：这里要证明的是"会返回"，不是精确耗时
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it('三项同时挂 → failed 三项齐全且顺序固定（便于 Grafana 解析）', async () => {
      const { service } = harness({
        prisma: () => Promise.reject(new Error('pg down')),
        queue: () => Promise.reject(new Error('queue down')),
        redisConnect: () => Promise.reject(new Error('redis down')),
      });

      const result = await service.checkReadiness();

      expect(result.status).toBe('error');
      expect(result.failed).toEqual(['pg', 'redis', 'queue']);
    });

    it('错误信息里的连接串凭据被抹掉（/health 可能对外可见）', async () => {
      const { service } = harness({
        prisma: () =>
          Promise.reject(
            new Error(
              "Can't reach database server at postgresql://argus:s3cr3t-pw@127.0.0.1:5432/argus",
            ),
          ),
      });

      const result = await service.checkReadiness();

      const error = result.checks.pg.error ?? '';
      expect(error).not.toContain('s3cr3t-pw');
      expect(error).toContain('***:***@');
      // 诊断信息本身要保留，否则脱敏等于把排查线索一起删了
      expect(error).toContain('127.0.0.1:5432');
    });

    it('超长错误被截断，不会把响应体撑大', async () => {
      const { service } = harness({
        prisma: () => Promise.reject(new Error('x'.repeat(5_000))),
      });

      const result = await service.checkReadiness();

      expect(result.checks.pg.error?.length).toBeLessThanOrEqual(301);
      expect(result.checks.pg.error?.endsWith('…')).toBe(true);
    });
  });
});
