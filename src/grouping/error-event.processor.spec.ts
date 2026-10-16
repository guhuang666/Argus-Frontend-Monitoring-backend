import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { PrismaService } from '../prisma/prisma.service';
import { DLQ_JOB_OPTIONS, ERROR_EVENT_JOB } from '../queue/queue.constants';
import { ErrorEventProcessor } from './error-event.processor';

/**
 * 三处核心逻辑，离线验证：
 *   ① 幂等闸门 —— 只有把 processed_at 从 NULL 抢成 now() 的那一次才继续
 *   ② 归并（W4）—— 算指纹 → upsert error_groups → 回填 group_id，
 *      且**必须和声明在同一个事务里**（放事务外会让重试被自己的闸门挡住）
 *   ③ 重试耗尽 → 转 DLQ（还有次数时只 warn，不能误判成终结）
 * 这三处判断错了都不会报错，只会静默丢数据、重复处理或归并漂移，
 * 所以必须有测试盯着。
 *
 * 两个 jest.mock 的原因同 error-events.service.spec.ts：
 *   · generated/prisma/client.ts 的 `./x.js` 指向 .ts 源文件，jest 解析不了
 *   · @nestjs/bullmq v12 是纯 ESM，jest 用 CJS 加载不了
 * 装饰器在手动 new 出来的实例上不起作用，替换成空实现即可。
 * 注：processor 里 `import type { Prisma }` 是纯类型导入，编译期被擦除，
 * 所以上面的 jest.mock 不会因为它而失效。
 */
jest.mock('@nestjs/bullmq', () => ({
  Processor: () => () => undefined,
  InjectQueue: () => () => undefined,
  OnWorkerEvent: () => () => undefined,
  WorkerHost: class WorkerHost {},
}));

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
}));

interface ClaimedEvent {
  event_id: string;
  mechanism: string;
  type: string;
  message: string;
  stack: string | null;
  timestamp: Date;
}

const CLAIMED: ClaimedEvent = {
  event_id: 'evt-1',
  mechanism: 'onerror',
  type: 'TypeError',
  message: 'Cannot read properties of undefined (reading "id")',
  // 带 origin / 目录 / 构建 hash 的真实形状：归并要拿它算指纹
  stack:
    'TypeError: x\n    at renderSummary (http://127.0.0.1:8017/assets/index-a1b2c3.js:348:13)',
  timestamp: new Date('2026-01-01T00:00:00Z'),
};

/** 假 Prisma：$transaction 直接把 tx 交给回调，$queryRaw 返回预置的声明结果 */
function fakePrisma(behavior: {
  claimed?: ClaimedEvent | null;
  existing?: { processedAt: Date | null } | null;
}) {
  const rows = behavior.claimed ? [behavior.claimed] : [];
  const calls: string[] = [];
  let upsertArgs: { where: unknown; create: Record<string, unknown> } | null = null;
  let updateArgs: { data: Record<string, unknown> } | null = null;

  return {
    calls,
    /** 归并时 errorGroup.upsert 的入参，供断言 where / create 用 */
    get upsertArgs() {
      return upsertArgs;
    },
    /** 回填时 errorEvent.update 的入参，供断言 groupId 用 */
    get updateArgs() {
      return updateArgs;
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      calls.push('tx:begin');
      return fn({
        $queryRaw: async () => {
          calls.push('tx:claim');
          return rows;
        },
        // W4 归并：这两步必须发生在 tx 里（放事务外会让重试被自己的闸门挡住）
        errorGroup: {
          upsert: async (args: unknown) => {
            calls.push('tx:upsertGroup');
            upsertArgs = args as { where: unknown; create: Record<string, unknown> };
            // timesSeen 返回 2n：模拟"这是第二次发生"，顺便验证 bigint 拼进日志不报错
            return { id: 'group-1', timesSeen: 2n };
          },
        },
        errorEvent: {
          update: async (args: unknown) => {
            calls.push('tx:updateEvent');
            updateArgs = args as { data: Record<string, unknown> };
            return {};
          },
        },
      });
    },
    errorEvent: {
      findUnique: async () => {
        calls.push('db:findUnique');
        return behavior.existing ?? null;
      },
    },
  };
}

/** 假 DLQ：记录 add 的入参，可选抛错 */
function fakeDlq(behavior: { add?: () => Promise<unknown> } = {}) {
  const added: Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }> =
    [];
  return {
    added,
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      if (behavior.add) return behavior.add();
      added.push({ name, data, opts });
      return { id: opts.jobId };
    },
  };
}

function build(prisma: ReturnType<typeof fakePrisma>, dlq: ReturnType<typeof fakeDlq>) {
  return new ErrorEventProcessor(
    prisma as unknown as PrismaService,
    dlq as unknown as Queue,
  );
}

/** 只造出被测代码真正用到的字段，其余强转 */
function jobLike(overrides: {
  attemptsMade?: number;
  attempts?: number;
  eventId?: string;
}): Job<{ eventId: string }> {
  return {
    id: 'evt-1',
    data: { eventId: overrides.eventId ?? 'evt-1' },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<{ eventId: string }>;
}

describe('ErrorEventProcessor', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'debug', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((msg: unknown) => void logged.push(String(msg)));
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('process：幂等闸门', () => {
    it('抢到声明 → 打印消费日志', async () => {
      const prisma = fakePrisma({ claimed: CLAIMED });
      const dlq = fakeDlq();

      await build(prisma, dlq).process(jobLike({}));

      expect(prisma.calls).toContain('tx:claim');
      expect(logged.some((l) => l.includes('已消费') && l.includes('evt-1'))).toBe(true);
      // 声明成功不该去查"为什么没抢到"（少一次查询）
      expect(prisma.calls).not.toContain('db:findUnique');
    });

    it('抢到声明后在**同一个事务内**归并并回填 group_id（W4）', async () => {
      const prisma = fakePrisma({ claimed: CLAIMED });
      const dlq = fakeDlq();

      await build(prisma, dlq).process(jobLike({}));

      // 顺序即证明：归并两步都发生在 tx:begin 之后，没有被挪到事务外
      expect(prisma.calls).toEqual([
        'tx:begin',
        'tx:claim',
        'tx:upsertGroup',
        'tx:updateEvent',
      ]);

      // upsert 的 where 用二元组唯一约束（MVP 去掉了 project_id）
      expect(prisma.upsertArgs?.where).toMatchObject({
        groupingVersion_fingerprint: {
          groupingVersion: 'v1-raw',
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
        },
      });

      // 首次创建：计数从 1 开始，首末时间都取自事件时间
      expect(prisma.upsertArgs?.create).toMatchObject({
        groupingVersion: 'v1-raw',
        title: expect.stringContaining('TypeError:') as unknown as string,
        culprit: 'index.js:renderSummary',
        timesSeen: 1,
      });

      // 回填 group_id，并把解析出的 frames 落库
      expect(prisma.updateArgs?.data).toMatchObject({ groupId: 'group-1' });
      expect(prisma.updateArgs?.data.stacktraceFrames).toBeDefined();

      // 日志带上了 group / fp / times，验收时不用查库
      const consumed = logged.find((l) => l.includes('已消费'));
      expect(consumed).toContain('group=group-1');
      expect(consumed).toContain('times=2');
    });

    it('没抢到闸门时绝不写库（不 upsert、不回填）', async () => {
      const prisma = fakePrisma({ claimed: null, existing: { processedAt: new Date() } });

      await build(prisma, fakeDlq()).process(jobLike({}));

      expect(prisma.calls).not.toContain('tx:upsertGroup');
      expect(prisma.calls).not.toContain('tx:updateEvent');
      expect(prisma.upsertArgs).toBeNull();
    });

    it('没抢到且事件已处理过 → 只 debug 跳过，不报错', async () => {
      const prisma = fakePrisma({ claimed: null, existing: { processedAt: new Date() } });
      const dlq = fakeDlq();

      await expect(build(prisma, dlq).process(jobLike({}))).resolves.toBeUndefined();

      expect(prisma.calls).toContain('db:findUnique');
      expect(logged.some((l) => l.includes('已处理过'))).toBe(true);
      expect(logged.some((l) => l.includes('事件不存在'))).toBe(false);
    });

    it('没抢到是因为事件不存在 → 明确 warn（job 指向了不存在的行）', async () => {
      const prisma = fakePrisma({ claimed: null, existing: null });

      await build(prisma, fakeDlq()).process(jobLike({}));

      expect(logged.some((l) => l.includes('事件不存在'))).toBe(true);
    });

    it('声明用的查询放在事务里（W4 要往里加归并，必须同事务）', async () => {
      const prisma = fakePrisma({ claimed: CLAIMED });

      await build(prisma, fakeDlq()).process(jobLike({}));

      expect(prisma.calls[0]).toBe('tx:begin');
    });
  });

  describe('onFailed：重试与 DLQ', () => {
    it('还有重试次数 → 只 warn，不转 DLQ', async () => {
      const dlq = fakeDlq();

      await build(fakePrisma({}), dlq).onFailed(jobLike({ attemptsMade: 1, attempts: 3 }), new Error('boom'));

      expect(dlq.added).toEqual([]);
      expect(logged.some((l) => l.includes('第 1/3 次失败，将重试'))).toBe(true);
    });

    it('重试耗尽（attemptsMade === attempts）→ 转入 DLQ', async () => {
      const dlq = fakeDlq();

      await build(fakePrisma({}), dlq).onFailed(jobLike({ attemptsMade: 3, attempts: 3 }), new Error('ECONNREFUSED'));

      expect(dlq.added).toHaveLength(1);
      expect(dlq.added[0].name).toBe(ERROR_EVENT_JOB);
      expect(dlq.added[0].data).toMatchObject({
        eventId: 'evt-1',
        failedReason: 'ECONNREFUSED',
        attemptsMade: 3,
      });
      expect(typeof dlq.added[0].data.failedAt).toBe('string');
      expect(logged.some((l) => l.includes('已转入 DLQ') && l.includes('evt-1'))).toBe(true);
    });

    it('DLQ 的 jobId 带时间戳：同一事件再次失败不会被去重吃掉', async () => {
      const dlq = fakeDlq();
      const processor = build(fakePrisma({}), dlq);

      await processor.onFailed(jobLike({ attemptsMade: 3 }), new Error('boom'));
      await processor.onFailed(jobLike({ attemptsMade: 3 }), new Error('boom again'));

      expect(dlq.added).toHaveLength(2);
      const ids = dlq.added.map((entry) => entry.opts.jobId);
      expect(ids[0]).toContain('evt-1');
      expect(ids[0]).not.toBe(ids[1]);
      // DLQ 不自动清理（要留得住东西）
      expect(dlq.added[0].opts).toMatchObject(DLQ_JOB_OPTIONS);
    });

    it('拿不到 job 对象（反序列化失败）也不崩', async () => {
      const dlq = fakeDlq();

      await expect(build(fakePrisma({}), dlq).onFailed(undefined, new Error('bad json'))).resolves
        .toBeUndefined();

      expect(dlq.added).toEqual([]);
      expect(logged.some((l) => l.includes('拿不到 job 详情'))).toBe(true);
    });

    it('DLQ 也写不进去时，用 error 级把失败现场留进日志', async () => {
      const dlq = fakeDlq({
        add: async () => {
          throw new Error('redis is down too');
        },
      });

      await expect(
        build(fakePrisma({}), dlq).onFailed(jobLike({ attemptsMade: 3 }), new Error('原始原因')),
      ).resolves.toBeUndefined();

      expect(
        logged.some((l) => l.includes('转入 DLQ 失败') && l.includes('原始原因')),
      ).toBe(true);
    });

    it('缺省 attempts 时按 1 次算：第一次失败就是终结', async () => {
      const dlq = fakeDlq();
      const job = jobLike({ attemptsMade: 1 });
      job.opts.attempts = undefined;

      await build(fakePrisma({}), dlq).onFailed(job, new Error('boom'));

      expect(dlq.added).toHaveLength(1);
    });
  });

  it('Worker 自身错误走 warn，不吞不崩', () => {
    const processor = build(fakePrisma({}), fakeDlq());

    processor.onError(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    expect(logged.some((l) => l.includes('Worker 异常') && l.includes('ECONNREFUSED'))).toBe(true);
  });
});
