import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ErrorEventsModule } from './error-events/error-events.module';
import { PerformanceModule } from './performance/performance.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // PostgreSQL 数据访问层。
    // 注：Mongoose 暂时保留 —— error-events / performance 两个模块还在用它，
    // 等 Prisma 侧跑通、业务代码迁完再整体摘除，避免一次改两件事。
    PrismaModule,
    ErrorEventsModule,
    PerformanceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
