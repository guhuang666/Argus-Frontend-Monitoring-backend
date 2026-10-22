import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ErrorEventsModule } from './error-events/error-events.module';
import { IssuesModule } from './issues/issues.module';
import { KeysModule } from './keys/keys.module';
import { PerformanceModule } from './performance/performance.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { RateLimitModule } from './ratelimit/ratelimit.module';
import { SourcemapsModule } from './sourcemaps/sourcemaps.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // PostgreSQL 数据访问层。
    // 注：Mongoose 暂时保留 —— error-events / performance 两个模块还在用它，
    // 等 Prisma 侧跑通、业务代码迁完再整体摘除，避免一次改两件事。
    PrismaModule,
    // 密钥解析（M4-S2）。@Global：上报/性能/上传/项目四处都要用。
    KeysModule,
    // 限流（M4-S6）。@Global：上报与性能两个入口的守卫都靠它实例化。
    // 依赖 KeysModule 里的 KeysService（它已是 @Global）。
    RateLimitModule,
    // 人身份（M4-S4）。@Global：四个读接口模块的守卫都靠它实例化。
    // 它只放 API 进程 —— worker 不鉴权，也不该有登录能力。
    AuthModule,
    ErrorEventsModule,
    PerformanceModule,
    // 问题管理（M2 的读接口 + 状态流转）。
    // 只有 API 进程需要它；worker.ts 的 WorkerModule 刻意不 import ——
    // 反过来 grouping.module.ts 也刻意不进这里，两边进程分工不能混。
    IssuesModule,
    // 项目列表/详情（M4-S2）：看板切换器与 DSN 展示的数据源
    ProjectsModule,
    // Sourcemap 上传（M3）。同样只在 API 进程 —— 落盘/入库发生在 HTTP 请求里，
    // worker 只需要"读"已存好的 map，那是另一个模块的事。
    SourcemapsModule,
    // 概览统计（批次 C）：趋势 + 总量 + 问题数，全部读 issue_stats_hourly。
    StatsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
