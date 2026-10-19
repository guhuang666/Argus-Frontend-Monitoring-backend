import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * jest 加载不了 generated/prisma/client.ts —— 它是 prisma-client 生成器产的 TS 源码，
 * 内部用 `./internal/class.js` 这种"指向 .ts 源文件"的写法，jest 的解析器不认
 * （只认真实存在的 class.js，而那里只有 class.ts）。
 *
 * 所以整个模块用工厂替换掉：本测试只需要 PrismaClientKnownRequestError 这一个运行时
 * 成员，用来让服务里的 `instanceof` 判断成立（伪造普通 Error 是走不到 duplicate 分支的，
 * 那样测的就不是这条契约了）。注意 PrismaService 只能 `import type`：类型引用会被擦除，
 * 一旦当成值引入，真实的 generated 模块又会被拉进来。
 */
jest.mock('../../generated/prisma/client', () => ({
  // prisma.service.ts 里是 `class PrismaService extends PrismaClient`，所以这个类必须存在，
  // 否则加载 PrismaService 时就 "Class extends value undefined"
  PrismaClient: class PrismaClient {},
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      readonly code: string;

      constructor(message: string, options: { code: string; clientVersion: string }) {
        super(message);
        this.code = options.code;
      }
    },
  },
}));

/**
 * 同理，@nestjs/bullmq v12 是**纯 ESM** 包（dist/index.js 里是 import/export），
 * jest 用 CJS 加载它会在 require 阶段就抛 "Must use import to load ES Module"。
 * 本测试只需要 InjectQueue 这个装饰器工厂，而装饰器在手动 `new` 出来的实例上
 * 本来就不起作用（DI 是容器的事），所以替换成一个空装饰器即可。
 */
jest.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => undefined,
}));
import { ERROR_EVENT_JOB, ERROR_EVENT_QUEUE } from '../queue/queue.constants';
import { ErrorEventsService } from './error-events.service';
import type { IngestErrorDto } from './dto/ingest-error.dto';

/**
 * ingest 的入队契约（W3）。
 *
 * 验收原本靠"起三个终端 + curl"，但那条路要在有 PG/Redis 的机器上跑；
 * 这里把可离线验证的那部分钉死：写库与入队的**顺序**、jobId 的形状、
 * duplicate 不入队、入队失败不许影响上报结果。
 */

/**
 * 上报时由鉴权解析出的项目 id。服务层不关心它从哪来，只要求必须带 ——
 * M4-S2 起 projectId 不再是服务内部算出来的默认值。
 */
const PROJECT_ID = '5f0a3d6e-8b1c-4f2a-9d3e-7c6b5a4f3e2d';

/** 最小的事件载荷，字段够过 DTO 形状即可（本测试不走 ValidationPipe） */
function payload(eventId: string): IngestErrorDto {
  return {
    event_id: eventId,
    mechanism: 'onerror',
    type: 'TypeError',
    message: 'boom',
  } as IngestErrorDto;
}

/** 记录调用顺序的假 Prisma：只实现 ingest 用到的那一个方法 */
function fakePrisma(behavior: { create: () => Promise<unknown> }) {
  const calls: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  return {
    calls,
    created,
    errorEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.push('db:create');
        created.push(args.data);
        return behavior.create();
      },
    },
  };
}

/** 假 Queue：记住 add 的入参，并可选地抛错 */
function fakeQueue(behavior: { add?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  return {
    calls,
    added,
    on: () => undefined,
    add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
      calls.push('queue:add');
      added.push({ name, data, opts });
      return behavior.add ? await behavior.add() : { id: opts.jobId };
    },
  };
}

function build(prisma: ReturnType<typeof fakePrisma>, queue: ReturnType<typeof fakeQueue>) {
  return new ErrorEventsService(
    prisma as unknown as PrismaService,
    // 这里只需要 Queue 的 add / on 两个方法，其余强转掉
    queue as unknown as Queue,
  );
}

describe('ErrorEventsService.ingest 的入队', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    // 让测试输出干净：日志内容单独收集，需要时断言
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg) => void logged.push(String(msg)));
    jest.spyOn(Logger.prototype, 'debug').mockImplementation((msg) => void logged.push(String(msg)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((msg) => void logged.push(String(msg)));
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((msg) => void logged.push(String(msg)));
  });

  afterEach(() => jest.restoreAllMocks());

  it('先写库、后入队（顺序不能反）', async () => {
    const prisma = fakePrisma({ create: async () => ({}) });
    const queue = fakeQueue();

    const result = await build(prisma, queue).ingest(payload('evt-1'), PROJECT_ID);

    expect(result).toEqual({ event_id: 'evt-1', duplicate: false });
    expect(prisma.calls).toEqual(['db:create']);
    expect(queue.calls).toEqual(['queue:add']);
    // 项目归属由调用方传入的那一个决定，不允许服务里出现任何兜底默认值
    expect(prisma.created[0].projectId).toBe(PROJECT_ID);
  });

  it('jobId 就是 event_id，job 名与队列名用契约里的常量', async () => {
    const prisma = fakePrisma({ create: async () => ({}) });
    const queue = fakeQueue();

    await build(prisma, queue).ingest(payload('550e8400-e29b-41d4-a716-446655440000'), PROJECT_ID);

    expect(queue.added).toHaveLength(1);
    expect(queue.added[0].name).toBe(ERROR_EVENT_JOB);
    expect(queue.added[0].data).toEqual({ eventId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(queue.added[0].opts.jobId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(queue.added[0].opts.attempts).toBe(3);
    expect(ERROR_EVENT_QUEUE).toBe('error-events');
  });

  it('重复上报（P2002）不入队', async () => {
    // 必须用真的 PrismaClientKnownRequestError：服务里是 instanceof 判断，伪造的普通
    // Error 走不到 duplicate 分支（那样测的就是"别的错误"，不是这条契约）
    const known = new Prisma.PrismaClientKnownRequestError('unique constraint', {
      code: 'P2002',
      clientVersion: 'test',
    });

    const prisma = fakePrisma({
      create: async () => {
        throw known;
      },
    });
    const queue = fakeQueue();

    const result = await build(prisma, queue).ingest(payload('evt-dup'), PROJECT_ID);

    expect(result).toEqual({ event_id: 'evt-dup', duplicate: true });
    expect(queue.calls).toEqual([]);
  });

  it('入队失败只记日志：事件已入库，上报结果仍是成功', async () => {
    const prisma = fakePrisma({ create: async () => ({}) });
    const queue = fakeQueue({
      add: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
    });

    const result = await build(prisma, queue).ingest(payload('evt-2'), PROJECT_ID);

    expect(result).toEqual({ event_id: 'evt-2', duplicate: false });
    expect(logged.some((line) => line.includes('入队失败') && line.includes('evt-2'))).toBe(true);
  });
});
