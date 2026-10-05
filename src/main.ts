import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Logger } from '@nestjs/common';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // SDK 与看板都在别的端口，不开跨域浏览器会直接拦下上报请求
  app.enableCors({ origin: true });

  const connection = app.get<Connection>(getConnectionToken());
  Logger.log(`MongoDB readyState=${connection.readyState} → ${connection.host}:${connection.port}/${connection.name}`, 'Bootstrap');
  await app.listen(process.env.PORT ?? 3000);
  
}
bootstrap();
