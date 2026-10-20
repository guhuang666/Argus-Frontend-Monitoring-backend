import { Global, Module } from '@nestjs/common';
import { IngestRateLimitGuard } from './ingest-rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

/**
 * 限流模块（M4-S6）。
 *
 * ── 为什么标 @Global ────────────────────────────────────────────────────
 * `IngestRateLimitGuard` 会被 error-events / performance 两个控制器用
 * `@UseGuards()` 引用，而守卫的依赖（KeysService、RateLimitService）
 * 必须在那两个模块的注入器里可见。要么每个模块各自 imports，要么全局注册。
 *
 * 选全局的理由与 AuthModule 一致：**让"加保护"变成一行注解**。
 * 反过来，如果每次都要记得 imports，早晚会漏一个 —— 而漏掉限流不会报错，
 * 只会让某个入口在洪峰时裸奔。
 *
 * 只放 API 进程：worker 不该有限流能力（它不接请求）。
 */
@Global()
@Module({
  providers: [RateLimitService, IngestRateLimitGuard],
  exports: [RateLimitService, IngestRateLimitGuard],
})
export class RateLimitModule {}
