import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

/** 端口被自己人占着时，最多重试几次（见 listenWithRetry 的注释） */
const LISTEN_RETRY_TIMES = 5;
/** 第 n 次重试等 n × 300ms —— 递增是为了让"上一个进程正在退出"这种短窗口必被跨过去 */
const LISTEN_RETRY_BASE_MS = 300;

/**
 * 监听端口；撞 EADDRINUSE 时退避重试。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 开发期 `npm run dev` 有两个进程在动 dist：一个编译、一个 `node --watch`。
 * 每次改代码都会触发"杀旧进程 + 起新进程"，而这两步不是原子的 ——
 * 新进程走到 listen() 时，旧进程可能刚被 SIGKILL、端口还没放开，
 * 于是 EADDRINUSE，而且**一撞就整个进程退出**：表现为
 * "api 偶尔起不来，得再改一次文件才恢复"。这个函数把那个几十毫秒的
 * 窗口跨过去，进程自己恢复，不用人去碰文件。
 *
 * ── 只对 EADDRINUSE 重试 ────────────────────────────────────────────────
 * EACCES（权限不足）、端口非法之类的立刻抛 —— 重试它们只会把真正的
 * 错误拖到 5 次之后，还可能伪装成"启动慢"。而端口被**别的服务**长期占着时，
 * 重试 5 次后照样抛原始错误，"起不来"这件事不会被掩盖。
 */
async function listenWithRetry(
  app: INestApplication,
  port: number | string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await app.listen(port);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || attempt >= LISTEN_RETRY_TIMES) {
        throw err;
      }
      const waitMs = LISTEN_RETRY_BASE_MS * attempt;
      Logger.warn(
        `端口 ${String(port)} 被占用，${waitMs}ms 后重试（第 ${attempt}/${LISTEN_RETRY_TIMES} 次）`,
        'Bootstrap',
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function bootstrap() {
  // bufferLogs: true —— 容器初始化阶段 Nest 就会打日志（模块加载、路由映射），
  // 那时 pino 还没就绪。不缓冲的话这批启动日志会直接丢失，
  // 而出问题时最需要的恰恰是启动日志。
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // 把 Nest 内置 Logger 接到 pino 上 —— 之后所有 `new Logger(X.name)`
  // 的输出都变成结构化 JSON，业务代码一行都不用改。
  app.useLogger(app.get(PinoLogger));

  // SIGTERM / SIGINT → 先关 HTTP 监听器（端口立刻释放），再逐个销毁 provider：
  // Prisma 连接池 $disconnect、BullMQ 优雅关闭都挂在 onModuleDestroy 上。
  // 不挂这个钩子，进程会直接死 —— 正在处理的请求被砍，连接池留给操作系统超时回收。
  // 开发期的附带收益：端口释放得更早，重启时的 EADDRINUSE 窗口更小。
  // （worker.ts 里是同一个立场，两边对称。）
  app.enableShutdownHooks();

  // 全局校验：DTO 上的 class-validator 装饰器靠它生效。
  // whitelist 会剥掉 DTO 未声明的字段，让入库数据形状可控。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // SDK 与看板都在别的端口，不开跨域浏览器会直接拦下上报请求
  app.enableCors({ origin: true });

  // 启动即确认数据库真的可用，并把「连的是哪个库」打进日志。
  // 连错库（比如 .env 里指向了别的实例）这种事，只有在启动这一刻看日志才能立刻发现，
  // 否则要等第一个上报请求落库、或者看板上查不到数据时才暴露。
  // PrismaService.onModuleInit 里的 $connect 已经建好连接池，这里再发一条最轻的查询
  // 验证链路真的通；失败就让进程起不来，而不是带病监听端口。
  const prisma = app.get(PrismaService);
  const [db] = await prisma.$queryRaw<
    Array<{ name: string; host: string | null; port: number | null }>
  >`SELECT current_database() AS name, host(inet_server_addr()) AS host, inet_server_port() AS port`;

  Logger.log(
    `PostgreSQL ready → ${db.host ?? '?'}:${db.port ?? '?'}/${db.name}`,
    'Bootstrap',
  );

  await listenWithRetry(app, process.env.PORT ?? 3000);
}
void bootstrap();
