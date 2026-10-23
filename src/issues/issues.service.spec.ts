import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { IssuesService } from './issues.service';
import type { ListIssuesQueryDto } from './dto/list-issues-query.dto';

/**
 * jest 加载不了 generated/prisma/client.ts —— 它是 generator 产出的 TS 源码，
 * 内部用 `./internal/class.js` 这种"指向 .ts 源文件"的写法，jest 的解析器不认
 * （同 stats.service.spec.ts / error-events.service.spec.ts 里那段说明）。
 *
 * `PrismaService` 在这里必须当**值**引入（它出现在构造函数的元数据里，
 * emitDecoratorMetadata 会在运行时引用它），所以这条依赖链绕不开，
 * 只能在模块层替换掉 generated client。
 */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';

/**
 * 假 Prisma：记录 findMany / count 收到的参数，返回空结果。
 *
 * 本文件要验的不是"查出来什么"（那要真库），而是**发出去的查询长什么样**：
 * where 里有没有漏掉 projectId、筛选条件有没有真的加上、
 * orderBy 有没有按白名单映射、分页参数对不对。
 * 这些一旦写错都是静默的 —— 页面照常渲染，只是数字不对。
 */
function fakePrisma() {
  const calls: {
    findMany: Array<Record<string, unknown>>;
    count: Array<Record<string, unknown>>;
    groupBy: Array<Record<string, unknown>>;
  } = { findMany: [], count: [], groupBy: [] };

  const prisma = {
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
    errorGroup: {
      findMany: (args: Record<string, unknown>) => {
        calls.findMany.push(args);
        return Promise.resolve([]);
      },
      count: (args: Record<string, unknown>) => {
        calls.count.push(args);
        return Promise.resolve(0);
      },
    },
  };

  return { prisma, calls };
}

function build() {
  const { prisma, calls } = fakePrisma();
  return {
    service: new IssuesService(prisma as unknown as PrismaService),
    calls,
  };
}

/** 只填必填项的最小查询；其余用 DTO 的默认值 */
function query(overrides: Partial<ListIssuesQueryDto> = {}): ListIssuesQueryDto {
  return {
    projectId: PROJECT,
    page: 1,
    pageSize: 20,
    sort: 'lastSeen',
    order: 'desc',
    ...overrides,
  } as ListIssuesQueryDto;
}

describe('IssuesService.listIssues（FR-8.3 六维筛选）', () => {
  it('不传任何筛选时，where 里只有 projectId（TC-08）', async () => {
    const { service, calls } = build();

    await service.listIssues(query());

    expect(calls.findMany[0].where).toEqual({ projectId: PROJECT });
    // 列表与总数必须用同一个 where，否则 total 是"全部"、items 是"筛过的"
    expect(calls.count[0].where).toEqual(calls.findMany[0].where);
  });

  it('六个维度可以同时生效', async () => {
    const { service, calls } = build();

    await service.listIssues(
      query({
        status: 'unresolved',
        level: 'error',
        release: 'web@1.2.0',
        environment: 'production',
        q: 'payment',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
      }),
    );

    const where = calls.findMany[0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      projectId: PROJECT,
      status: 'unresolved',
      level: 'error',
      lastRelease: 'web@1.2.0',
      lastEnvironment: 'production',
    });
    // 关键字同时搜 title 与 culprit（culprit 是"疑似责任位置"，按它搜更常用）
    expect(where.OR).toHaveLength(2);
    expect(JSON.stringify(where.OR)).toContain('"contains":"payment"');
    // 时间范围落在 last_seen 上，且是左闭右开
    const lastSeen = where.lastSeen as { gte?: Date; lt?: Date };
    expect(lastSeen.gte?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(lastSeen.lt?.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('排序字段按白名单映射；未知值退化成默认（lastSeen）', async () => {
    const times = build();
    await times.service.listIssues(query({ sort: 'timesSeen', order: 'desc' }));
    expect(times.calls.findMany[0].orderBy).toEqual([
      { timesSeen: 'desc' },
      { id: 'asc' },
    ]);

    const users = build();
    await users.service.listIssues(query({ sort: 'usersSeen', order: 'asc' }));
    expect(users.calls.findMany[0].orderBy).toEqual([
      { usersSeen: 'asc' },
      { id: 'asc' },
    ]);

    const unknown = build();
    await unknown.service.listIssues(
      query({ sort: 'evil; DROP TABLE' as never }),
    );
    // 不是报错，而是安静地退回默认 —— 关键是不能把字符串拼进语句
    expect(unknown.calls.findMany[0].orderBy).toEqual([
      { lastSeen: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('第二排序键固定为 id：同分行翻页不会重复/漏行', async () => {
    const { service, calls } = build();

    await service.listIssues(query());

    expect(calls.findMany[0].orderBy).toHaveLength(2);
    expect((calls.findMany[0].orderBy as unknown[])[1]).toEqual({ id: 'asc' });
  });

  it('from 晚于 to → 400，且一条查询都不发', async () => {
    const { service, calls } = build();

    await expect(
      service.listIssues(
        query({
          from: '2026-10-02T00:00:00.000Z',
          to: '2026-10-01T00:00:00.000Z',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(calls.findMany).toHaveLength(0);
    expect(calls.count).toHaveLength(0);
  });

  it('只给 from 或只给 to 也合法（单边开区间）', async () => {
    const fromOnly = build();
    await fromOnly.service.listIssues(query({ from: '2026-10-01T00:00:00Z' }));
    const where = fromOnly.calls.findMany[0].where as {
      lastSeen: { gte?: Date; lt?: Date };
    };
    expect(where.lastSeen.gte).toBeInstanceOf(Date);
    expect(where.lastSeen.lt).toBeUndefined();
  });

  it('分页参数换算成 skip/take', async () => {
    const { service, calls } = build();

    await service.listIssues(query({ page: 3, pageSize: 25 }));

    expect(calls.findMany[0].skip).toBe(50);
    expect(calls.findMany[0].take).toBe(25);
  });
});

describe('IssuesService.facets（筛选栏下拉）', () => {
  it('只查 last_release / last_environment 的去重值，且带 projectId', async () => {
    const { service, calls } = build();

    const result = await service.facets(PROJECT);

    expect(result).toEqual({ releases: [], environments: [] });
    expect(calls.findMany).toHaveLength(2);
    for (const args of calls.findMany) {
      const where = args.where as Prisma.ErrorGroupWhereInput;
      expect(where.projectId).toBe(PROJECT);
    }
    // 取值必须与"筛选筛的那两列"同源，否则会出现下拉里有、选中却没结果
    expect(JSON.stringify(calls.findMany[0].select)).toContain('lastRelease');
    expect(JSON.stringify(calls.findMany[1].select)).toContain('lastEnvironment');
  });
});
