import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

/** 全局唯一的锁 key。评估器是"全局单例任务"，不按项目分锁 */
const LOCK_KEY = 'alert:evaluator:lock';

/**
 * 锁的过期时间：**比评估周期短 5 秒**。
 *
 * 取 55s 而不是 60s，是为了防止"上一轮的锁刚好和下一轮同时到期"：
 * 如果 TTL 等于周期，时钟稍偏一点就会出现两个评估器同时在跑。
 * 反过来也不能太短 —— 一轮评估（规则数 × 查询）必须能在 TTL 内跑完，
 * 否则下一轮会抢到锁、和还在跑的这一轮重叠。
 */
const LOCK_TTL_MS = 55_000;

/**
 * 释放锁时必须"确认这锁还是我的"。
 *
 * 直接 DEL 有个经典事故：本轮评估超过 55 秒 → 锁自动过期 → 另一实例拿到同名锁
 * → 本轮结束时把**别人的**锁删了。用 Lua 把"读 token + 比对 + 删"做成原子操作，
 * 只有 token 对得上才删。
 */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * 评估器的分布式锁（M6-3 步骤①）。
 *
 * 为什么要锁：`worker.ts` 可以起多个副本，每个副本都有一个每 60 秒跑的评估器。
 * 没有锁的话，一次超标会被评估 N 次、发 N 条消息 —— 这是告警系统最伤信任的
 * 一种表现（"怎么又是这条"）。
 *
 * 为什么用 Redis 而不是数据库行锁：锁的生命周期是秒级、且"拿不到就跳过"，
 * 这正是 SET NX PX 的语义；数据库行锁会占着连接，还得处理事务边界。
 */
@Injectable()
export class EvaluatorLock implements OnModuleDestroy {
  private readonly logger = new Logger(EvaluatorLock.name);
  private readonly redis: Redis;

  constructor() {
    // 与 RateLimitService 用同一套 env；两套配置各自读一遍迟早会漂移
    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      // 抢锁是短操作：Redis 不可用时立刻失败，不要让评估器卡在等重连上
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (err: Error) => {
      // 持续刷 error 只会淹没真正重要的日志
      this.logger.warn(`Redis 不可用，评估锁将抢不到：${err.message}`);
    });
  }

  /** 抢到返回 token（释放时要用），抢不到返回 null */
  async tryAcquire(): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
    return result === 'OK' ? token : null;
  }

  async release(token: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, LOCK_KEY, token);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
