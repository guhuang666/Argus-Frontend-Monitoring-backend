import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

/** 限流判定结果。三元组直接对应 429 响应里要写的两个头 */
export interface RateLimitVerdict {
  /** 这次放不放行 */
  allowed: boolean;
  /** 本窗口还剩多少额度（被拒时为 0；fail-open 时为 -1 表示"未知"） */
  remaining: number;
  /** 还要等多少毫秒才能再试（放行时为 0） */
  retryAfterMs: number;
}

/**
 * 单次检查的时间窗口。1 秒对应 FR-6.1「每项目每秒请求数」。
 * FR-6.2 还要求"每分钟事件数"，那是第二个维度 —— 加一个 key + 换 windowMs 即可，
 * 现在先只做秒级（上报入口一次请求就是一条事件，两个维度暂时等价）。
 */
const WINDOW_MS = 1000;

/**
 * 滑动窗口的 Lua 实现（FR-6.1 / FR-6.7）。
 *
 * ── 为什么必须写成整段脚本 ──────────────────────────────────────────────
 * 「删掉窗口外的 → 数一数 → 没满就记上」这三步如果由 Node 分三次发，
 * 两个并发请求会**都数到"还差一个"**，然后都放行，上限被突破。
 * 这种错不报任何日志，只在洪峰时出现 —— 也就是唯一需要它准确的时刻。
 *
 * Redis 执行脚本期间不处理其它命令，所以这三步对其它请求是"不可分割"的。
 *
 * KEYS[1] = 记事本名字
 * ARGV[1..4] = 当前毫秒时间戳 / 窗口毫秒 / 上限条数 / 本次唯一成员
 */
const RATE_LIMIT_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

-- ① 砍掉窗口外的旧记录（分数严格小于 now-window）
redis.call('ZREMRANGEBYSCORE', key, 0, '(' .. (now - window))

-- ② 数窗口内还剩几条
local count = redis.call('ZCARD', key)

-- ③ 已经满了：拒绝，并算出最早那条什么时候滑出窗口
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 0
  if oldest[2] then
    retryAfter = tonumber(oldest[2]) + window - now
  end
  return { 0, 0, retryAfter }
end

-- ④ 没满：把这次记上
redis.call('ZADD', key, now, member)

-- ⑤ 给 key 一个寿命，别让停止上报的项目在 Redis 里留垃圾
redis.call('PEXPIRE', key, window)

-- ⑥ 允许 / 剩余额度 / 无需等待
return { 1, limit - count - 1, 0 }
`;

/**
 * 按项目的滑动窗口限流（M4-S6）。
 *
 * ── 它和 BullMQ 队列是两回事 ────────────────────────────────────────────
 * `bull:error-events:*` 是"待处理的活儿"，这里的 `rl:proj:<id>` 是
 * "最近一秒每条请求什么时候来的"。限流发生在**写库和入队之前** ——
 * 被拒的请求既不会落库，也不会产生 job。
 *
 * ── 为什么状态必须放 Redis ──────────────────────────────────────────────
 * 计数是"多实例共用 + 必须原子读写"的状态：放进程内存的话，
 * 2 个 API 实例各数 100，实际就放过 200；进程重启还会清零。
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly redis: Redis;

  constructor() {
    // 连接配置与 queue.module.ts 用同一套 env，避免两套配置漂移
    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      // 限流是辅助能力：Redis 抖动时不该让每个请求都卡在等重连上
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (err: Error) => {
      // 不往上抛：连接错误会持续触发，抛出去只会把日志刷爆
      this.logger.warn(`Redis 不可用，限流将 fail-open：${err.message}`);
    });
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  /**
   * 对外唯一入口：按项目做一次滑动窗口检查。
   *
   * ── fail-open 是刻意的 ──────────────────────────────────────────────────
   * 限流组件自己挂了时**放行**，而不是拒绝。
   * 这是监控系统：第一职责是如实记录发生了什么。为了限流把所有上报丢掉，
   * 等于客户在自己出事的时候看到一片空白 —— 本末倒置。
   * 代价是"闸门暂时打开"，所以这里必须打日志（将来接告警）。
   */
  async check(projectId: string, limit: number, windowMs: number = WINDOW_MS): Promise<RateLimitVerdict> {
    // 上限 <= 0 视为不限制（配错时宁可放开，不要把人锁死在外面）
    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true, remaining: -1, retryAfterMs: 0 };
    }

    const key = `rl:proj:${projectId}:sec`;
    const now = Date.now();
    // member 必须唯一：ZADD 对同 member 是"改分数"而不是"新增"，
    // 撞了就会少算条目 → 限流被放松。所以用随机 UUID，绝不用时间戳。
    const member = randomUUID();

    try {
      return await this.acquireByLua(key, now, windowMs, limit, member);
    } catch (err) {
      this.logger.error(`限流检查失败，fail-open 放行：${String(err)}`);
      return { allowed: true, remaining: -1, retryAfterMs: 0 };
    }
  }

  /**
   * 版本 B：整段交给 Redis 执行（**准确**，生产用这个）。
   *
   * ioredis 会自动处理 EVALSHA：第一次发脚本原文，之后用缓存里的 SHA，
   * 所以不是每次都传 30 行脚本文本。
   */
  async acquireByLua(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    member: string,
  ): Promise<RateLimitVerdict> {
    const raw = (await this.redis.eval(
      RATE_LIMIT_LUA,
      1, // KEYS 只有 1 个
      key,
      now,
      windowMs,
      limit,
      member,
    )) as [number | string, number | string, number | string];

    const allowed = Number(raw[0]) === 1;
    return {
      allowed,
      remaining: Math.max(0, Number(raw[1])),
      retryAfterMs: Math.max(0, Number(raw[2])),
    };
  }

  /**
   * 版本 A：三条命令分开发（**有竞态，仅用于压测对照**）。
   *
   * 逻辑与 Lua 版逐行对应，唯一差别是"分三次网络往返"。
   * 保留它只为一件事：量出"没有原子性时会超发多少" ——
   * 那是 FR-6.7 要求的对照数据。生产路径不要用它。
   */
  async acquireByCommands(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    member: string,
  ): Promise<RateLimitVerdict> {
    // 三步之间的空隙，就是并发请求插队进来的地方
    await this.redis.zremrangebyscore(key, 0, `(${now - windowMs}`);

    const count = await this.redis.zcard(key);

    if (count >= limit) {
      // 注意 start/stop 要传字符串：ioredis 的 'WITHSCORES' 重载把 stop
      // 声明成 string | Buffer，传数字会命中另一个重载然后类型报错
      const oldest = await this.redis.zrange(key, '0', '0', 'WITHSCORES');
      const oldestScore = oldest[1] === undefined ? now : Number(oldest[1]);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldestScore + windowMs - now),
      };
    }

    await this.redis.zadd(key, now, member);
    await this.redis.pexpire(key, windowMs);

    return { allowed: true, remaining: Math.max(0, limit - count - 1), retryAfterMs: 0 };
  }
}
