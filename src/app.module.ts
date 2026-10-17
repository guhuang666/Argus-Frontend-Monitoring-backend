import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ErrorEventsModule } from './error-events/error-events.module';
import { IssuesModule } from './issues/issues.module';
import { PerformanceModule } from './performance/performance.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueryModule } from './query/query.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // PostgreSQL 数据访问层。
    // 注：Mongoose 暂时保留 —— error-events / performance 两个模块还在用它，
    // 等 Prisma 侧跑通、业务代码迁完再整体摘除，避免一次改两件事。
    PrismaModule,
    ErrorEventsModule,
    PerformanceModule,
    // 问题管理（M2 的读接口 + 状态流转）。
    // 只有 API 进程需要它；worker.ts 的 WorkerModule 刻意不 import ——
    // 反过来 grouping.module.ts 也刻意不进这里，两边进程分工不能混。
    IssuesModule,
    QueryModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
