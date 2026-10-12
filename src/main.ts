import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  const connection = app.get<Connection>(getConnectionToken());
  Logger.log(
    `MongoDB readyState=${connection.readyState} → ${connection.host}:${connection.port}/${connection.name}`,
    'Bootstrap',
  );

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
