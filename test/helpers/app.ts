import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';

/**
 * e2e 的统一入口：起一个与 main.ts 行为一致的测试应用。
 *
 * ── 为什么需要这层封装（而不是每个 spec 抄一遍 beforeAll）──────────────
 * main.ts 里有三件事在测试环境**不会自动生效**，每次都必须手动重放：
 *
 *   ① 全局 ValidationPipe —— 不挂的话 class-validator 完全不跑，
 *      非法入参会一路走到 Prisma 才炸（500 而不是 400），
 *      于是测试通过/失败反映的根本不是生产行为。
 *   ② 用 `app.init()` 而不是 `app.listen()`：Supertest 直接拿内存里的
 *      http server（`app.getHttpServer()`），不占端口，并行跑也不会撞端口。
 *   ③ 关闭必须 `app.close()`：Prisma 连接池、BullMQ 队列都挂在
 *      onModuleDestroy 上，不关的话 jest 进程会挂住不退出。
 *
 * 抽出来之后，新增一个 spec 只需要两行：
 *   beforeAll(async () => { app = await createTestApp(); });
 *   afterAll(async () => { await app.close(); });
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  // 与 main.ts 里的全局管道保持一致。改这里必须同步改 main.ts，否则
  // "测试里校验通过、线上被拒"这类漂移永远查不出来。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  await app.init();
  return app;
}
