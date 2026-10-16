import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { ERROR_EVENT_DLQ, ERROR_EVENT_QUEUE } from './queue.constants';

/**
 * 队列基础设施（W3）。
 *
 * 两件事：给 BullMQ 配 Redis 连接（forRoot），再把本系统用到的队列注册出来。
 *
 * ── 为什么要把 registerQueue 的结果存进常量 ──────────────────────────────
 * `BullModule.registerQueue()` 每次调用都返回一个**新的** DynamicModule 对象。
 * Nest 认的是对象同一性，所以 imports 里注册的那个和 exports 里导出的那个必须是
 * 同一个引用，否则下游 @InjectQueue 拿不到 provider（报 "Nest can't resolve
 * dependencies"）。存成模块级常量，天然保证是同一个。
 *
 * ── 连接配置 ────────────────────────────────────────────────────────────
 * 默认连 127.0.0.1:6379（docker-compose 里的 redis），可用 REDIS_HOST / REDIS_PORT
 * 覆盖。刻意**不设** maxRetriesPerRequest：BullMQ 要求阻塞连接（Worker 那条）的
 * 该值是 null，显式设了会被它覆盖并打一条 deprecation 警告，不如统一用默认值。
 */
const errorEventQueue = BullModule.registerQueue({ name: ERROR_EVENT_QUEUE });
const errorEventDlq = BullModule.registerQueue({ name: ERROR_EVENT_DLQ });

/**
 * Redis 连接错误的统一出口。
 *
 * 为什么需要它：bullmq 的 `emit()` 对 'error' 事件做了兜底 —— 没有监听者时不会崩进程，
 * 而是把原始 Error **直接 console.error** 出去（queue-base.js:79-93）。后果是 Redis
 * 一断，终端里滚的是这种裸栈：
 *
 *     Error: connect ECONNREFUSED 127.0.0.1:6379
 *         at TCPConnectWrap.afterConnect (node:net:1645:16) { errno: -4078, ... }
 *
 * 它绕过了 Nest 的日志体系（没有时间戳、没有 context），而且按重试策略反复出现 ——
 * 一次 Redis 抖动就能把日志冲得没法看。挂上监听者，把它收敛成一行警告。
 *
 * 两个进程都生效：API 进程（只投递）与 Worker 进程（投递 + 消费）都 import 本模块。
 */
@Injectable()
class QueueErrorLogger {
  private readonly logger = new Logger(QueueErrorLogger.name);

  constructor(
    @InjectQueue(ERROR_EVENT_QUEUE) private readonly workQueue: Queue,
    @InjectQueue(ERROR_EVENT_DLQ) private readonly dlq: Queue,
  ) {
    // 挂在**构造函数**里而不是 onModuleInit —— 这一点是被实测逼出来的：
    // Nest 的 onModuleInit 是"按模块顺序依次调"的，只要前面某个模块的钩子抛错
    // （典型案例：PG 连不上，PrismaModule 的钩子卡几秒后抛），后面模块的钩子
    // 就再也不会执行。而 BullMQ 的连接在 provider 构造阶段就已经开始尝试了，
    // 钩子挂监听等于永远慢一步，Redis 的错误只能裸奔到 console。
    // provider 的构造发生在所有钩子之前，挂在这里才是真正的"最早"。
    const queues: Array<[string, Queue]> = [
      [ERROR_EVENT_QUEUE, this.workQueue],
      [ERROR_EVENT_DLQ, this.dlq],
    ];

    for (const [name, queue] of queues) {
      queue.on('error', (err: Error) => {
        this.logger.warn(`队列「${name}」连接异常: ${err.message}`);
      });
    }
  }
}

@Module({
  imports: [
    BullModule.forRootAsync({
      // ConfigModule 在 AppModule / WorkerModule 里都是 forRoot({ isGlobal: true })，
      // 这里仍显式声明一次：Worker 是独立进程，配置来源必须自己写清楚，不靠"全局"
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('REDIS_HOST') ?? '127.0.0.1';
        const rawPort = config.get<string>('REDIS_PORT');
        const port = rawPort ? Number(rawPort) : 6379;

        // 端口写错（REDIS_PORT=abc、空串）时给一条能看懂的错，而不是让 ioredis
        // 报一个 "connect ECONNREFUSED ::1:NaN" 之类的天书
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error(`REDIS_PORT 不是合法端口: ${String(rawPort)}`);
        }

        return { connection: { host, port } };
      },
    }),
    errorEventQueue,
    errorEventDlq,
  ],
  providers: [QueueErrorLogger],
  exports: [errorEventQueue, errorEventDlq],
})
export class QueueModule {}
