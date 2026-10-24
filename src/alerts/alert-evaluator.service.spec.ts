import type { AlertRule } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AlertDeliveryService } from './alert-delivery.service';
import { AlertEvaluatorService, isSilenced, isTriggered } from './alert-evaluator.service';
import { buildLink, buildMessage } from './alert-message';
import type { EvaluatorLock } from './evaluator-lock';

/**
 * 同另外几个 spec：generated/prisma/client 是 generator 产的 TS，
 * jest 解析不了它内部的 .js 后缀，只能在模块层替换掉。
 */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
}));

const NOW = new Date('2026-10-24T12:00:00.000Z');
const PROJECT = '11111111-1111-4111-8111-111111111111';
const RULE = '33333333-3333-4333-8333-333333333333';

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: RULE,
    projectId: PROJECT,
    name: '错误暴涨',
    metric: 'events',
    comparator: 'gt',
    threshold: 10,
    windowMinutes: 5,
    environment: null,
    release: null,
    channel: 'feishu',
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret',
    silenceMinutes: 30,
    enabled: true,
    lastFiredAt: null,
    createdAt: new Date('2026-10-24T04:30:00Z'),
    ...overrides,
  } as AlertRule;
}

/**
 * 假 Prisma。$queryRaw 按 SQL 里的关键字分派返回值 —— 本文件要验的是
 * "算出来的值有没有正确地走完判定链"，不是 SQL 本身对不对。
 */
function fakePrisma(init: {
  rules?: AlertRule[];
  /** 按 SQL 关键字给返回值；不认识的返回空数组（= 0 / null） */
  answer?: (sql: string) => unknown[];
  updateCount?: number;
} = {}) {
  const calls = {
    findMany: [] as Array<Record<string, unknown>>,
    updateMany: [] as Array<Record<string, unknown>>,
    create: [] as Array<Record<string, unknown>>,
    raw: [] as Array<{ sql: string; values: unknown[] }>,
  };

  const prisma = {
    alertRule: {
      findMany: (args: Record<string, unknown>) => {
        calls.findMany.push(args);
        return Promise.resolve(init.rules ?? []);
      },
      updateMany: (args: Record<string, unknown>) => {
        calls.updateMany.push(args);
        return Promise.resolve({ count: init.updateCount ?? 1 });
      },
    },
    // 通知里要显示项目名：M6-4 起每条触发的规则都会查一次（进程内缓存）
    project: {
      findUnique: () => Promise.resolve({ name: '默认项目' }),
    },
    alertEvent: {
      create: (args: Record<string, unknown>) => {
        calls.create.push(args);
        return Promise.resolve({});
      },
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      calls.raw.push({ sql, values });
      return Promise.resolve(init.answer?.(sql) ?? []);
    },
  };

  return { prisma, calls };
}

function fakeDelivery(ok: boolean, error?: string) {
  const calls: Array<{ ruleId: string; text: string }> = [];
  const delivery = {
    deliver: (r: AlertRule, text: string) => {
      calls.push({ ruleId: r.id, text });
      return Promise.resolve(ok ? { ok: true } : { ok: false, error: error ?? 'boom' });
    },
  };
  return { delivery, calls };
}

function fakeLock(acquired = true) {
  let released = false;
  const lock = {
    tryAcquire: () => Promise.resolve(acquired ? 'token-1' : null),
    release: () => {
      released = true;
      return Promise.resolve();
    },
  };
  return { lock, released: () => released };
}

function build(options: {
  rules?: AlertRule[];
  answer?: (sql: string) => unknown[];
  delivered?: boolean;
  deliveryError?: string;
  updateCount?: number;
  lockAcquired?: boolean;
} = {}) {
  const { prisma, calls } = fakePrisma(options);
  const { delivery, calls: deliveries } = fakeDelivery(options.delivered ?? true, options.deliveryError);
  const { lock, released } = fakeLock(options.lockAcquired ?? true);

  const service = new AlertEvaluatorService(
    prisma as unknown as PrismaService,
    delivery as unknown as AlertDeliveryService,
    lock as unknown as EvaluatorLock,
  );

  return { service, calls, deliveries, released };
}

/** 默认按"错误数 = 11"回答，用来快速构造"越线"的场景 */
const elevenEvents = (sql: string): unknown[] =>
  sql.includes('COUNT(DISTINCT user_id)') ? [{ n: 3 }] : [{ n: 11 }];

describe('AlertEvaluatorService.evaluateOnce（M6-3）', () => {
  it('越过阈值 + 投递成功：打开静默闸门并记一条 delivered=true 的历史', async () => {
    const { service, calls, deliveries } = build({ rules: [rule()], answer: elevenEvents });

    const summary = await service.evaluateOnce(NOW);

    expect(summary.triggered).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(deliveries).toHaveLength(1);

    // 只有投递成功之后才会更新 lastFiredAt
    expect(calls.updateMany).toHaveLength(1);
    expect(calls.updateMany[0]?.where).toMatchObject({ id: RULE, projectId: PROJECT });
    expect(calls.updateMany[0]?.data).toEqual({ lastFiredAt: NOW });

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.data).toMatchObject({ delivered: true, value: 11 });

    // M6-4：通知里要有项目名和直达链接（否则收到消息的人还得自己去后台翻）
    expect(deliveries[0]?.text).toContain('🔴 [默认项目] 错误数告警');
    expect(deliveries[0]?.text).toContain(
      `查看：http://localhost:5173/projects/${PROJECT}/issues`,
    );
  });

  it('投递失败：不更新 lastFiredAt，但留一条 delivered=false 的历史', async () => {
    const { service, calls } = build({
      rules: [rule()],
      answer: elevenEvents,
      delivered: false,
      deliveryError: 'HTTP 500',
    });

    const summary = await service.evaluateOnce(NOW);

    expect(summary.failed).toBe(1);
    // 关键断言：静默闸门没有被打开 —— 下一轮还会重试，用户仍然有机会收到
    expect(calls.updateMany).toHaveLength(0);
    expect(calls.create[0]?.data).toMatchObject({ delivered: false, error: 'HTTP 500' });
  });

  it('静默期内：不投递、不写历史、不更新闸门', async () => {
    const { service, calls, deliveries } = build({
      rules: [rule({ lastFiredAt: new Date(NOW.getTime() - 10 * 60_000) })],
      answer: elevenEvents,
    });

    const summary = await service.evaluateOnce(NOW);

    expect(summary.triggered).toBe(1);
    expect(summary.silenced).toBe(1);
    expect(deliveries).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
    expect(calls.updateMany).toHaveLength(0);
  });

  it('静默期已过：再次触发', async () => {
    const { service, deliveries } = build({
      rules: [rule({ lastFiredAt: new Date(NOW.getTime() - 31 * 60_000) })],
      answer: elevenEvents,
    });

    await service.evaluateOnce(NOW);

    expect(deliveries).toHaveLength(1);
  });

  it('窗口内没有会话 → error_rate 视为无样本，lt 规则也不会误报', async () => {
    const { service, deliveries } = build({
      rules: [rule({ metric: 'error_rate', comparator: 'lt', threshold: 0.05 })],
      answer: (sql) => (sql.includes('sessions') ? [{ total: 0, errored: 0 }] : []),
    });

    const summary = await service.evaluateOnce(NOW);

    expect(summary.noData).toBe(1);
    expect(summary.triggered).toBe(0);
    expect(deliveries).toHaveLength(0);
  });

  it('lt 规则：错误率 1% < 5% 时触发', async () => {
    const { service, deliveries } = build({
      rules: [rule({ metric: 'error_rate', comparator: 'lt', threshold: 0.05 })],
      answer: (sql) => (sql.includes('sessions') ? [{ total: 100, errored: 1 }] : []),
    });

    await service.evaluateOnce(NOW);

    expect(deliveries).toHaveLength(1);
  });

  it('窗口是 [now-window, now)：同一条规则里 from 与 to 的差正好等于窗口长度', async () => {
    const { service, calls } = build({ rules: [rule({ windowMinutes: 5 })], answer: elevenEvents });

    await service.evaluateOnce(NOW);

    const eventsQuery = calls.raw.find((call) => call.sql.includes('FROM error_events'));
    expect(eventsQuery).toBeDefined();

    const from = eventsQuery?.values.find((v) => v instanceof Date && v.getTime() === NOW.getTime() - 5 * 60_000);
    const to = eventsQuery?.values.find((v) => v instanceof Date && v.getTime() === NOW.getTime());
    expect(from).toBeInstanceOf(Date);
    expect(to).toBeInstanceOf(Date);
  });

  it('多项目多规则：所有查询共用同一个 to（避免相邻两轮重复计入边界）', async () => {
    const { service, calls } = build({
      rules: [rule({ id: 'a', projectId: PROJECT }), rule({ id: 'b', projectId: '22222222-2222-4222-8222-222222222222' })],
      answer: elevenEvents,
    });

    await service.evaluateOnce(NOW);

    const ends = calls.raw
      .map((call) => call.values.filter((v) => v instanceof Date && v.getTime() === NOW.getTime()))
      .filter((list) => list.length > 0);
    expect(ends.length).toBeGreaterThanOrEqual(2);
  });

  it('锁被占用时不查库、不投递', async () => {
    const { service, calls, deliveries, released } = build({ rules: [rule()], lockAcquired: false });

    await service.tick();

    expect(calls.findMany).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
    // 没抢到锁就不该去释放它（否则会删掉别人的锁）
    expect(released()).toBe(false);
  });

  it('tick 会释放锁', async () => {
    const { service, released } = build({ rules: [rule()], answer: elevenEvents });

    await service.tick();

    expect(released()).toBe(true);
  });

  it('一轮查完所有启用规则（不是逐条查）', async () => {
    const { service, calls } = build({ rules: [rule({ id: 'a' }), rule({ id: 'b' })], answer: elevenEvents });

    await service.evaluateOnce(NOW);

    expect(calls.findMany).toHaveLength(1);
    expect(calls.findMany[0]?.where).toEqual({ enabled: true });
  });
});

describe('阈值比较与静默判定', () => {
  it('gt/lt 都是严格不等：正好等于阈值不触发', () => {
    expect(isTriggered('gt', 10, 10)).toBe(false);
    expect(isTriggered('gt', 10.001, 10)).toBe(true);
    expect(isTriggered('lt', 5, 5)).toBe(false);
    expect(isTriggered('lt', 4.999, 5)).toBe(true);
  });

  it('静默期按"距离上次成功通知"算，不是"这段时间没触发"', () => {
    const base = { silenceMinutes: 30 } as Pick<AlertRule, 'lastFiredAt' | 'silenceMinutes'>;
    expect(isSilenced({ ...base, lastFiredAt: null }, NOW)).toBe(false);
    expect(isSilenced({ ...base, lastFiredAt: new Date(NOW.getTime() - 29 * 60_000) }, NOW)).toBe(true);
    expect(isSilenced({ ...base, lastFiredAt: new Date(NOW.getTime() - 30 * 60_000) }, NOW)).toBe(false);
    // 静默期 0 = 不静默
    expect(
      isSilenced(
        { silenceMinutes: 0, lastFiredAt: new Date(NOW.getTime() - 1000) },
        NOW,
      ),
    ).toBe(false);
  });

  it('通知文案带项目名、当前值、阈值与直达链接', () => {
    const text = buildMessage({
      rule: rule(),
      value: 11,
      projectName: '默认项目',
      link: 'http://localhost:5173/projects/p1/issues/g1',
      extras: {
        users: 3,
        firstSeen: new Date('2026-10-24T10:15:02Z'),
        lastSeen: new Date('2026-10-24T10:19:44Z'),
        topGroupId: 'g1',
      },
    });

    expect(text).toContain('🔴 [默认项目] 错误数告警');
    expect(text).toContain('最近 5 分钟发生 11 次（阈值 > 10）');
    expect(text).toContain('影响用户 3');
    expect(text).toContain('10-24 10:15:02');
    expect(text).toContain('查看：http://localhost:5173/projects/p1/issues/g1');
  });

  it('没有 extras 时不输出"影响用户 undefined"那行', () => {
    const text = buildMessage({
      rule: rule({ metric: 'lcp_p75', threshold: 2500 }),
      value: 3120,
      projectName: '默认项目',
      link: 'http://localhost:5173/projects/p1/issues',
      extras: null,
    });

    expect(text).not.toContain('影响用户');
    expect(text).toContain('LCP P75 3120 ms');
  });

  it('错误率的文案按百分比渲染，而不是 0.0123', () => {
    const text = buildMessage({
      rule: rule({ metric: 'error_rate', comparator: 'lt', threshold: 0.05 }),
      value: 0.0123,
      projectName: '默认项目',
      link: 'http://localhost:5173/projects/p1/issues',
      extras: null,
    });

    expect(text).toContain('错误率 1.23%');
    expect(text).toContain('阈值 < 5%');
  });

  it('有 groupId 时链接直达问题详情，没有时退回问题列表', () => {
    expect(buildLink('http://localhost:5173', 'p1', 'g1')).toBe(
      'http://localhost:5173/projects/p1/issues/g1',
    );
    expect(buildLink('http://localhost:5173/', 'p1', null)).toBe(
      'http://localhost:5173/projects/p1/issues',
    );
  });
});
