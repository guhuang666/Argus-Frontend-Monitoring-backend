import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  // bufferLogs: true —— 容器初始化阶段 Nest 就会打日志（模块加载、路由映射），
  // 那时 pino 还没就绪。不缓冲的话这批启动日志会直接丢失，
  // 而出问题时最需要的恰恰是启动日志。
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // 把 Nest 内置 Logger 接到 pino 上 —— 之后所有 `new Logger(X.name)`
  // 的输出都变成结构化 JSON，业务代码一行都不用改。
  app.useLogger(app.get(PinoLogger));

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

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
