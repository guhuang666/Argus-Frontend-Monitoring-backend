import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from './../src/prisma/prisma.service';
import { createTestApp } from './helpers/app';

/**
 * 健康检查 e2e
 *
 * ── 它是所有其它 e2e 的**前置检查** ────────────────────────────────────
 * AppModule 起不来、或 PG / Redis / 队列连不上时，这个 suite 会先红，
 * 你就不用去猜后面那些失败是不是连锁反应。
 *
 * ── 环境变量统一在 test/e2e-setup.ts ──────────────────────────────────
 * 那个文件由 jest 的 `setupFiles` 在**测试文件被 import 之前**执行，
 * 所以 DATABASE_URL（?schema=e2e）、RATE_LIMIT_ENABLED、JWT_SECRET、
 * LOG_LEVEL 都已经就位 —— 这里不再自己赋值。
 * 两处写同一份 env 的风险是：改一处忘另一处，行为悄悄漂移。
 */
describe('健康检查 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    // hook 默认只有 5s，而这里要等连接池、Redis、队列全部就绪
  }, 30_000);

  afterAll(async () => {
    // 必须关：Prisma 连接池、限流用的 ioredis、BullMQ 队列都挂在
    // onModuleDestroy 上。不 close 的话这些连接一直开着，Jest 跑完不退出
    await app.close();
  });

  it('连的是 e2e schema，不是开发库', async () => {
    const [row] = await prisma.$queryRaw<Array<{ schema: string }>>`
      SELECT current_schema() AS schema
    `;

    // 保险丝：万一 DATABASE_URL 没生效，它立刻红在这里，
    // 而不是让后面的用例把数据写进开发库
    expect(row.schema).toBe('e2e');
  });

  it('GET /api/v1/health/live → 200', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);

    // live 刻意不碰任何依赖，只证明"进程活着、事件循环还转"
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/v1/health/ready → 200（PG / Redis / 队列 三条都通）', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

    // 故意不用 .expect(200)：依赖断了时 Jest 只会说 "expected 200, got 503"，
    // 还得自己猜是哪条断的。这样断言失败信息里直接带着 failed: ['redis'] 之类
    expect({ status: res.status, failed: res.body.failed }).toEqual({
      status: 200,
      failed: [],
    });
  });
});
