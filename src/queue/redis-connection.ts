import type { ConnectionOptions } from 'bullmq';

/**
 * Redis 连接配置的唯一来源。
 *
 * 为什么抽出来：`queue.module.ts` 的 `forRootAsync` 和 S7 的每项目 Worker 都要连
 * Redis。两处各读一遍 env 迟早会漂移（改了这里忘了那里，表现是"生产者写进 A 库、
 * 消费者读 B 库"，最难查）。所以只留这一个函数，谁都调它。
 *
 * 刻意**不设** maxRetriesPerRequest：BullMQ 要求 Worker 那条阻塞连接的值是 null，
 * 显式设了会被它覆盖并打 deprecation 警告，不如统一用默认值。
 */
export function buildRedisConnection(env: NodeJS.ProcessEnv = process.env): ConnectionOptions {
  const host = env.REDIS_HOST ?? '127.0.0.1';
  const rawPort = env.REDIS_PORT;
  const port = rawPort ? Number(rawPort) : 6379;

  // 端口写错（REDIS_PORT=abc、空串）时给一条能看懂的错，
  // 而不是让 ioredis 报 "connect ECONNREFUSED ::1:NaN" 之类的天书
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`REDIS_PORT 不是合法端口: ${String(rawPort)}`);
  }

  return { host, port };
}
