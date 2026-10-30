import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/app';
import { createProject, resetDb, type TestProject } from './helpers/fixtures';

/**
 * 上报接口的 e2e（第一层：HTTP → 校验 → 入库）。
 *
 * ── 这里验的四件事，恰好是"这个项目的三条硬约束"的入口面 ────────────────
 *   ① 合法事件能落库，且**归属由公钥决定**（不是由请求体决定）—— TC-05
 *   ② 同一 event_id 重复上报不产生第二行 —— 幂等/NFR-2.5
 *   ③ 没有钥匙就是 401，不会悄悄写进去 —— NFR-3.1
 *   ④ 非法入参是 400 而不是 500 —— 顺带证明全局 ValidationPipe 真的挂上了
 */
describe('上报接口 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  /** 每条用例一份全新的项目与钥匙，用例之间零共享状态 */
  let fx: TestProject;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    fx = await createProject(prisma);
  });

  const EVENT = {
    event_id: 'e2e-0001',
    mechanism: 'onerror' as const,
    type: 'TypeError',
    message: 'e2e boom',
  };

  /** 简化调用：不传 key 就模拟"没带公钥"的请求 */
  function post(body: unknown, key?: string) {
    const req = request(app.getHttpServer()).post('/api/v1/error').send(body);
    return key === undefined ? req : req.set('X-Argus-Key', key);
  }

  it('合法事件 → 201，且落进钥匙所属的项目', async () => {
    const res = await post(EVENT, fx.publicKey).expect(201);

    expect(res.body).toEqual({ event_id: EVENT.event_id, duplicate: false });

    const row = await prisma.errorEvent.findUnique({ where: { eventId: EVENT.event_id } });
    // 项目身份只来自钥匙：请求体里塞什么 project_id 都不会被采信
    expect(row?.projectId).toBe(fx.projectId);
    expect(row?.message).toBe(EVENT.message);
  });

  it('同一 event_id 重复上报 → duplicate:true，库里仍只有一行', async () => {
    await post(EVENT, fx.publicKey).expect(201);

    const res = await post(EVENT, fx.publicKey).expect(201);
    expect(res.body.duplicate).toBe(true);

    expect(await prisma.errorEvent.count({ where: { projectId: fx.projectId } })).toBe(1);
  });

  it('不带公钥 → 401，且不写库', async () => {
    await post(EVENT).expect(401);
    expect(await prisma.errorEvent.count()).toBe(0);
  });

  it('mechanism 非法 → 400（这条同时是"全局管道是否生效"的探针）', async () => {
    // 忘了在 helpers/app.ts 里挂 ValidationPipe 的话，这里会变成 500
    // （非法 enum 一路走到 Prisma 才报错），所以它 400 就说明管道真的在
    await post({ ...EVENT, event_id: 'e2e-0002', mechanism: 'bogus' }, fx.publicKey).expect(400);
  });
});
