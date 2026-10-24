import { NotFoundException } from '@nestjs/common';
import type { AlertRule } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from './alerts.service';
import type { CreateAlertRuleDto } from './dto/create-alert-rule.dto';
import type { UpdateAlertRuleDto } from './dto/update-alert-rule.dto';

/**
 * jest 加载不了 generated/prisma/client.ts（generator 产的 TS 源码内部用
 * `./internal/class.js` 指向未编译的 .ts），所以整条链只能在模块层替换掉。
 * 同 issues.service.spec.ts / stats.service.spec.ts 的写法。
 */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const OTHER_RULE = '44444444-4444-4444-8444-444444444444';

/** 一行 alert_rules。要改哪个字段就 override 哪个 */
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
    // 完整地址：脱敏断言就是围绕它做的
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/9f8e7d6c5b4a',
    silenceMinutes: 30,
    enabled: true,
    lastFiredAt: null,
    createdAt: new Date('2026-10-24T04:30:00Z'),
    ...overrides,
  } as AlertRule;
}

/**
 * 假 Prisma：只记录"发出去的查询长什么样"，不模拟查询语义。
 *
 * 本文件要验的是**查询里有没有带上 projectId**（TC-05）、
 * **PATCH 有没有把没传的字段写成 null**、**响应里有没有泄露 webhook 明文**。
 * 这三类错误都是静默的：接口照常 200，只是越权了 / 配置被清空了 / 密钥泄露了。
 */
function fakePrisma(init: {
  listRows?: AlertRule[];
  updateCount?: number;
  deleteCount?: number;
  current?: AlertRule | null;
  updatedRow?: AlertRule;
} = {}) {
  const calls = {
    findMany: [] as Array<Record<string, unknown>>,
    create: [] as Array<Record<string, unknown>>,
    updateMany: [] as Array<Record<string, unknown>>,
    findUniqueOrThrow: [] as Array<Record<string, unknown>>,
    findFirst: [] as Array<Record<string, unknown>>,
    deleteMany: [] as Array<Record<string, unknown>>,
  };

  const prisma = {
    alertRule: {
      findMany: (args: Record<string, unknown>) => {
        calls.findMany.push(args);
        return Promise.resolve(init.listRows ?? []);
      },
      create: (args: Record<string, unknown>) => {
        calls.create.push(args);
        return Promise.resolve(rule());
      },
      updateMany: (args: Record<string, unknown>) => {
        calls.updateMany.push(args);
        return Promise.resolve({ count: init.updateCount ?? 1 });
      },
      findUniqueOrThrow: (args: Record<string, unknown>) => {
        calls.findUniqueOrThrow.push(args);
        return Promise.resolve(init.updatedRow ?? rule());
      },
      findFirst: (args: Record<string, unknown>) => {
        calls.findFirst.push(args);
        return Promise.resolve(init.current === undefined ? rule() : init.current);
      },
      deleteMany: (args: Record<string, unknown>) => {
        calls.deleteMany.push(args);
        return Promise.resolve({ count: init.deleteCount ?? 1 });
      },
    },
  };

  return { prisma, calls };
}

function build(init: Parameters<typeof fakePrisma>[0] = {}) {
  const { prisma, calls } = fakePrisma(init);
  return { service: new AlertsService(prisma as unknown as PrismaService), calls };
}

const CREATE_BODY: CreateAlertRuleDto = {
  name: '错误暴涨',
  metric: 'events',
  comparator: 'gt',
  threshold: 10,
  window_minutes: 5,
  channel: 'feishu',
  webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/9f8e7d6c5b4a',
  silence_minutes: 30,
  enabled: true,
};

describe('AlertsService.list', () => {
  it('where 只带 projectId，不按 enabled 过滤（停用的规则必须还在列表里）', async () => {
    const { service, calls } = build();

    await service.list(PROJECT);

    expect(calls.findMany[0]).toEqual({
      where: { projectId: PROJECT },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('响应里没有 webhook 明文，只有末 6 位', async () => {
    const { service } = build({ listRows: [rule()] });

    const result = await service.list(PROJECT);
    const item = result.items[0];

    expect(item?.webhook_url_masked).toBe('***6c5b4a');
    // 整串 JSON 里不能出现完整地址的任何一个"可复用片段"
    expect(JSON.stringify(result)).not.toContain('https://open.feishu.cn');
    expect(item?.webhook_url_set).toBe(true);
  });
});

describe('AlertsService.create', () => {
  it('把 projectId 写进 data —— 项目身份来自路由，不由请求体决定', async () => {
    const { service, calls } = build();

    const created = await service.create(PROJECT, CREATE_BODY);

    expect(calls.create[0]?.data).toMatchObject({
      projectId: PROJECT,
      name: '错误暴涨',
      metric: 'events',
      comparator: 'gt',
      threshold: 10,
      windowMinutes: 5,
      channel: 'feishu',
      // 入库必须是明文：投递器要拿它发请求
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/9f8e7d6c5b4a',
      silenceMinutes: 30,
      enabled: true,
      environment: null,
      release: null,
    });
    // 但返回给调用方的仍然是脱敏后的
    expect(created.webhook_url_masked).toBe('***6c5b4a');
  });
});

describe('AlertsService.update', () => {
  it('updateMany 的 where 同时带 id 和 projectId（TC-05）', async () => {
    const { service, calls } = build();

    await service.update(PROJECT, RULE, { enabled: false });

    expect(calls.updateMany[0]?.where).toEqual({ id: RULE, projectId: PROJECT });
  });

  it('只更新传了的字段，没传的不能变成 null', async () => {
    const { service, calls } = build();

    await service.update(PROJECT, RULE, { enabled: false });

    expect(calls.updateMany[0]?.data).toEqual({ enabled: false });
  });

  it('不传 webhook_url = 保持原地址（前端只拿得到脱敏值）', async () => {
    const { service, calls } = build();

    await service.update(PROJECT, RULE, { name: '改个名' });

    expect(calls.updateMany[0]?.data).toEqual({ name: '改个名' });
    expect(calls.updateMany[0]?.data).not.toHaveProperty('webhookUrl');
  });

  it('一条语句都没匹配到 → 404（别人的规则、不存在的 id 都是这个结果）', async () => {
    const { service } = build({ updateCount: 0 });

    await expect(service.update(OTHER_PROJECT, OTHER_RULE, { enabled: false })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('PATCH 空 body 是"什么都不改"，不发 update', async () => {
    const { service, calls } = build({ current: rule() });

    const result = await service.update(PROJECT, RULE, {});

    expect(calls.findFirst[0]?.where).toEqual({ id: RULE, projectId: PROJECT });
    expect(calls.updateMany).toHaveLength(0);
    expect(result.id).toBe(RULE);
  });

  it('空 body 且规则不存在 → 404', async () => {
    const { service } = build({ current: null });

    await expect(service.update(PROJECT, RULE, {} as UpdateAlertRuleDto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AlertsService.remove', () => {
  it('deleteMany 的 where 同时带 id 和 projectId', async () => {
    const { service, calls } = build();

    await service.remove(PROJECT, RULE);

    expect(calls.deleteMany[0]?.where).toEqual({ id: RULE, projectId: PROJECT });
  });

  it('没匹配到 → 404', async () => {
    const { service } = build({ deleteCount: 0 });

    await expect(service.remove(PROJECT, RULE)).rejects.toBeInstanceOf(NotFoundException);
  });
});
