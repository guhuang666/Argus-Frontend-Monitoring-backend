import { getQueueToken } from '@nestjs/bullmq';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { GroupingModule } from './grouping/grouping.module';
import { ProjectWorkerManager } from './grouping/project-worker.manager';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { ProjectQueueService } from './queue/project-queue.service';
import { ERROR_EVENT_QUEUE } from './queue/queue.constants';
import { QueueModule } from './queue/queue.module';

/**
 * 归并 Worker 进程入口（W3）。
 *
 * 与 main.ts 的关系：**同一个代码库、两套进程**。
 *   · main.ts    → HTTP 进程：收上报、写库、入队（不消费）
 *   · worker.ts  → 后台进程：消费队列、做归并（不监听端口）
 * 所以这里用 createApplicationContext（standalone application）而不是
 * NestFactory.create：不需要 HTTP 适配器，也就不该占端口。
 *
 * 入口刻意不 import AppModule：那会把 controllers 一起拉进容器。
 * 需要什么就 import 什么。
 */

/** Nest Logger 的 context，两个进程的日志混在一个终端时靠它区分 */
const BOOTSTRAP = 'WorkerBootstrap';

/**
 * Redis 就绪等待上限。
 *
 * 对齐 main.ts 的立场：启动即验证依赖可用，"失败就让进程起不来，而不是带病监听"。
 * 留 10 秒是给"先起 worker、后起 redis"这种手抖留的余量 —— 超时就明确报错退出，
 * 而不是留一个既没连上 Redis、又看起来活着的空转进程（那种最难查）。
 */
const REDIS_READY_TIMEOUT_MS = 10_000;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    QueueModule,
    // GroupingModule 带来 ErrorEventProcessor —— 也就是"消费"这件事本身。
    // 只有本进程 import 它，API 进程绝不会（见 grouping.module.ts 的警告）。
    GroupingModule,
  ],
})
class WorkerModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // SIGINT / SIGTERM → 触发 onModuleDestroy：Prisma 断连、BullMQ 优雅关闭
  // （正在处理的 job 会先跑完再退，不会做到一半被砍）
  app.enableShutdownHooks();

  // 与 main.ts 同样先确认"连的是哪个库"，并把结论打进日志 —— 两个进程连错库
  // 这种事，只有在启动这一刻看日志才能立刻发现
  const prisma = app.get(PrismaService);
  const [db] = await prisma.$queryRaw<
    Array<{ name: string; host: string | null; port: number | null }>
  >`SELECT current_database() AS name, host(inet_server_addr()) AS host, inet_server_port() AS port`;
  Logger.log(`PostgreSQL ready → ${db.host ?? '?'}:${db.port ?? '?'}/${db.name}`, BOOTSTRAP);

  const queue = app.get<Queue>(getQueueToken(ERROR_EVENT_QUEUE));
  const redisReady = await waitUntilReady(queue);

  if (!redisReady) {
    Logger.error(
      `Redis 在 ${REDIS_READY_TIMEOUT_MS / 1000}s 内未就绪，队列无法消费，进程退出。\n` +
        `  本地起 Redis：docker compose up -d redis\n` +
        `  连接参数：REDIS_HOST / REDIS_PORT（默认 127.0.0.1:6379）`,
      undefined,
      BOOTSTRAP,
    );
    await app.close();
    process.exit(1);
  }

  // 队列存量一起打出来：验收时"curl 之后 waiting 动了、processed_at 变了"一眼能对上，
  // 不用另开 redis-cli。
  //
  // S7 起没有"一条全局队列"了 —— 每个项目一条 error-events-<projectId>。
  // 所以这里遍历 manager 已经启动的那些项目，逐个报存量。
  const queues = app.get(ProjectQueueService);
  const listening = app.get(ProjectWorkerManager).listens();

  if (listening.length === 0) {
    Logger.warn(
      '归并 Worker 已就绪，但当前没有任何启用的项目（没有队列可消费）',
      BOOTSTRAP,
    );
    return;
  }

  Logger.log(`归并 Worker 已就绪 → 正在消费 ${listening.length} 个项目的队列`, BOOTSTRAP);

  for (const { projectId, name } of listening) {
    const counts = await queues
      .queueFor(projectId)
      .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    Logger.log(`  · 「${name}」 ${JSON.stringify(counts)}`, BOOTSTRAP);
  }
}

/**
 * 等 Redis 就绪，超时返回 false。
 *
 * 不用裸 await queue.waitUntilReady()：Redis 没起时它会一直等下去，bootstrap 悄悄
 * 挂住，外面看到的是"进程起来了但什么都不干"。加个上限，超时就是一个明确的失败。
 */
async function waitUntilReady(queue: Queue): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Redis 未在 ${REDIS_READY_TIMEOUT_MS}ms 内就绪`)),
          REDIS_READY_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

void bootstrap();
