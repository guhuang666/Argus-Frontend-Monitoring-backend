import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { HealthController } from './health.controller';
import {
  createRedisProbe,
  HEALTH_OPTIONS,
  HealthService,
  REDIS_PROBE_FACTORY,
} from './health.service';

/**
 * 健康检查（M6-0）。只放 API 进程 —— worker 没有 HTTP 端口，探针无处可打。
 *
 * imports QueueModule：ready 里的"队列"一项要拿 `@InjectQueue(ERROR_EVENT_QUEUE)`。
 * 这不是新增连接：ErrorEventsModule 已经 import 过它，Nest 对同一个模块类
 * 只实例化一次，BullMQ 的连接还是那几条。
 *
 * ── 三个 provider 的用意 ────────────────────────────────────────────────
 *   REDIS_PROBE_FACTORY  把"怎么造 Redis 客户端"变成可替换的依赖，
 *                        单测才能在不启动 Redis 的情况下验证 503 分支
 *   HEALTH_OPTIONS       超时值。抽出来是为了让单测把 1500ms 压到 20ms，
 *                        否则"排队等超时"的三条用例会把测试拖成 5 秒
 */
@Module({
  imports: [QueueModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    // useValue 而不是 useFactory：createRedisProbe 是纯函数（只读 env、不持状态），
    // 直接当值给出去即可；每次调用返回新客户端这件事由函数本身的语义保证
    { provide: REDIS_PROBE_FACTORY, useValue: createRedisProbe },
    { provide: HEALTH_OPTIONS, useValue: { timeoutMs: 1_500 } },
  ],
})
export class HealthModule {}
