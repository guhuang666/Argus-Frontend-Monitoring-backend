import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from './sessions.service';

/**
 * jest 加载不了 generated/prisma/client.ts（同其它 spec 的说明）。
 * `PrismaService` 出现在构造函数的元数据里，是值引用，绕不开这条依赖链。
 */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';

/** 假 Prisma：只记 $executeRaw 收到的语句和参数 */
function fakePrisma(behavior: { throws?: Error } = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const prisma = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      if (behavior.throws) return Promise.reject(behavior.throws);
      return Promise.resolve(1);
    },
  };

  return { prisma, calls };
}

function build(behavior: { throws?: Error } = {}) {
  const { prisma, calls } = fakePrisma(behavior);
  return {
    service: new SessionsService(prisma as unknown as PrismaService),
    calls,
  };
}

describe('SessionsService.touch', () => {
  let warned: string[];

  beforeEach(() => {
    warned = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((msg) => void warned.push(String(msg)));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('没有 session_id 时一条 SQL 都不发（性能/错误事件可能不带会话）', async () => {
    const { service, calls } = build();

    await service.touch({ projectId: PROJECT, sessionId: null });
    await service.touch({ projectId: PROJECT, sessionId: undefined });
    await service.touch({ projectId: PROJECT, sessionId: '   ' });

    expect(calls).toHaveLength(0);
  });

  it('写入用 ON CONFLICT：last_seen 取 GREATEST、page_views 累加、had_error 取 OR', async () => {
    const { service, calls } = build();

    await service.touch({
      projectId: PROJECT,
      sessionId: 'sess-1',
      userKey: 'u_alice',
      at: new Date('2026-10-23T06:00:00.000Z'),
      hasError: true,
      pageViews: 1,
    });

    const sql = calls[0].text.replace(/\s+/g, ' ');

    // 幂等与并发安全全靠这三条：读改写会留竞态
    expect(sql).toContain('ON CONFLICT (project_id, id) DO UPDATE');
    expect(sql).toContain('GREATEST(sessions.last_seen_at, EXCLUDED.last_seen_at)');
    expect(sql).toContain('page_views = sessions.page_views + EXCLUDED.page_views');
    expect(sql).toContain('had_error = sessions.had_error OR EXCLUDED.had_error');
    // 匿名会话后来登录：补上身份，但不覆盖已有值
    expect(sql).toContain('COALESCE(sessions.user_key, EXCLUDED.user_key)');

    // projectId 走参数绑定并显式转 uuid，不拼进语句文本（注入面）
    expect(calls[0].values).toContain(PROJECT);
    expect(sql).not.toContain(PROJECT);
  });

  it('session_id 超过列宽时截断到 100（否则 P2000 会让整次写入失败）', async () => {
    const { service, calls } = build();

    await service.touch({ projectId: PROJECT, sessionId: 'x'.repeat(150) });

    const stored = calls[0].values[0];
    expect(typeof stored).toBe('string');
    expect((stored as string).length).toBe(100);
  });

  it('默认值：hasError=false、pageViews=0（错误链路与性能链路各传各的）', async () => {
    const { service, calls } = build();

    await service.touch({ projectId: PROJECT, sessionId: 'sess-1' });

    const values = calls[0].values;
    // 参数顺序：id, projectId, userKey, at, at, pageViews, hasError
    expect(values[2]).toBeNull(); // userKey
    expect(values[5]).toBe(0); // pageViews
    expect(values[6]).toBe(false); // hasError
  });

  it('数据库报错只 warn，绝不抛出（会话是统计旁路）', async () => {
    const { service } = build({ throws: new Error('connection lost') });

    await expect(
      service.touch({ projectId: PROJECT, sessionId: 'sess-1' }),
    ).resolves.toBeUndefined();

    expect(warned.some((line) => line.includes('会话写入失败'))).toBe(true);
  });
});
