import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { buildRedisConnection } from '../queue/redis-connection';
import { ERROR_EVENT_QUEUE } from '../queue/queue.constants';

/**
 * ── 为什么这两个 token 声明在 class 之前 ──────────────────────────────────
 * 它们是构造参数装饰器 `@Inject(...)` 的实参，而装饰器在**类定义时**就会被求值。
 * 把 `const` 写在文件末尾的话，此时它还在 TDZ 里，编译期直接报
 * "Block-scoped variable used before its declaration"。
 * 语义上它们确实是"注入用的标签"，放最前面也最贴近注入点。
 */

/** 健康检查的可调参数。抽成 token 是为了单测能把超时压到几十毫秒 */
export interface HealthOptions {
  timeoutMs: number;
}

export const HEALTH_OPTIONS = Symbol('HEALTH_OPTIONS');

/**
 * 探针用的 Redis 客户端工厂。
 *
 * 抽成 DI token 而不是在 service 里直接 `new Redis()`：单测不该为了验证
 * "Redis 挂了会不会 503" 去真的有一个 Redis。
 */
export interface RedisProbe {
  connect(): Promise<void>;
  ping(): Promise<string>;
  disconnect(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type RedisProbeFactory = () => RedisProbe;

export const REDIS_PROBE_FACTORY = Symbol('REDIS_PROBE_FACTORY');

/**
 * 健康检查（M6-0 / FR-7.x）。
 *
 * ── 为什么必须拆成 live 和 ready 两个接口 ────────────────────────────────
 * 两个接口回答的是**两个不同的问题**，答案会触发**两种不同的动作**：
 *
 *   /live    "这个进程还能干活吗？"   → 不能 → **重启它**
 *   /ready   "现在能给它导流量吗？"   → 不能 → **暂时别导流量**（进程别动）
 *
 * 混成一个接口时，两种故障会得到同一个结论，而那个结论一定是错的：
 *   · Redis 挂了，但进程完全正常 → 单接口报"不健康" → 编排系统**重启进程**
 *     → 重启之后 Redis 还是挂的，于是无限重启，故障从"队列停了"升级成"服务全停"
 *   · 进程内死锁（依赖都通）→ 单接口因为能连上 Redis 而报"健康" → 持续把流量
 *     导给一个已经不能响应的进程
 *
 * 所以 live **故意不查任何依赖**：它只证明"这个 Node 进程还活着、事件循环还转"。
 * 任何依赖故障都不该让 live 变红 —— 那是 ready 的职责。
 *
 * ── 为什么 ready 查三项而不是一项 ───────────────────────────────────────
 * PG、Redis、队列是三条独立的故障路径，运维要能一眼看出断的是哪条：
 *   · PG 断 → 上报和所有读接口全废（最严重）
 *   · Redis 断 → 队列停摆，事件还能落库但不会被归并；限流会 fail-open
 *   · 队列断（Redis 通但队列不可用）→ 只影响"投递"这一段
 * 只回一个 503 而不说哪项坏了，值班的人第一步还得自己去猜。
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ERROR_EVENT_QUEUE) private readonly queue: Queue,
    @Inject(REDIS_PROBE_FACTORY)
    private readonly createRedis: RedisProbeFactory,
    @Inject(HEALTH_OPTIONS) private readonly options: HealthOptions,
  ) {}

  /**
   * 存活探针：**不碰任何依赖**。
   *
   * 这里唯一能做错的事就是"顺手查一下数据库"——那会让数据库抖动
   * 变成一次"重启全部 API 实例"。要查依赖，用 ready。
   *
   * uptime / pid 不是给编排系统看的，是给值班的人第一眼确认
   * "这是我以为的那个进程吗、它是不是刚重启过"。
   */
  checkLiveness(): LivenessResult {
    return {
      status: 'ok',
      // 进程已运行秒数。数值很小 = 刚刚被重启过，这本身就是排查线索
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid,
      time: new Date().toISOString(),
    };
  }

  /**
   * 就绪探针：三项并行查，任一失败 → 整体 `error`（控制器据此回 503）。
   *
   * 并行而不是串行：串行时总耗时是三项之和，PG 慢一点会把 Redis 的检查也拖过超时，
   * 结果报出一个"其实没坏"的失败项。并行时总耗时 ≈ 最慢的那一项。
   */
  async checkReadiness(): Promise<ReadinessResult> {
    const startedAt = Date.now();

    const [pg, redis, queue] = await Promise.all([
      this.runCheck('pg', () => this.checkPostgres()),
      this.runCheck('redis', () => this.checkRedis()),
      this.runCheck('queue', () => this.checkQueue()),
    ]);

    const checks = { pg, redis, queue };
    const failed = (Object.keys(checks) as CheckName[]).filter(
      (name) => !checks[name].ok,
    );

    if (failed.length > 0) {
      // 只在失败时打日志：健康探针每 10 秒跑一次，成功也打会把日志淹掉
      this.logger.warn(
        `就绪检查未通过：${failed.join(', ')}（PG ${pg.durationMs}ms / Redis ${redis.durationMs}ms / 队列 ${queue.durationMs}ms）`,
      );
    }

    return {
      status: failed.length === 0 ? 'ok' : 'error',
      checkedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      checks,
      failed,
    };
  }

  /** 最轻的一次往返：证明连接池能拿到连接、PG 能执行语句 */
  private async checkPostgres(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  /**
   * Redis：一次真正的 PING，不是一个缓存的"上次连上了"标志位。
   *
   * ── 为什么每次检查都新建一个客户端 ──────────────────────────────────────
   * 常驻探针客户端有个隐蔽的问题：Redis 断开后 ioredis 会按 retryStrategy
   * 在后台无限重连，而 `status` 字段可能一直停在 'connecting'。
   * 用它做健康检查，等于在查"这个客户端对象现在什么状态"，
   * 而不是"Redis 现在能不能用"。新建客户端 + 用后即弃，语义最直白：
   * 探针的每一次结论都来自一次**刚刚发生的**真实连接。
   *
   * 代价是每次探针一条 TCP 连接（10 秒一次、量级可忽略）。
   * 若将来探针频率提高到秒级，再改成共享客户端并显式管理重连状态。
   */
  private async checkRedis(): Promise<void> {
    const client = this.createRedis();

    /**
     * ⚠️ 必须挂 error 监听者，否则 EventEmitter 的 'error' 事件没有监听者时
     * 会被抛成未捕获异常 —— 一个"检查 Redis 通不通"的功能，反而能把进程搞挂。
     *
     * 顺带把最后一条错误记下来：**ioredis 真正的失败原因只从 'error' 事件出来**，
     * 而 `connect()` 的 rejection 常常只有一句 "Connection is closed."
     * （enableOfflineQueue=false 时尤其如此）。只报那句话，值班的人还得自己
     * 去猜是不是端口写错了、Redis 没起、还是网络不通。
     */
    let lastError: Error | undefined;
    client.on('error', (err: Error) => {
      lastError = err;
    });

    try {
      await client.connect();
      const pong = await client.ping();
      // PING 正常只会回 PONG。回别的说明对面不是我们以为的那个 Redis
      if (pong !== 'PONG') {
        throw new Error(`PING 返回了意外的值: ${String(pong)}`);
      }
    } catch (err) {
      // 优先报底层的连接错误（它带 ECONNREFUSED / 地址 / 端口）
      throw lastError ?? err;
    } finally {
      // 无论成功失败都断开：失败时不清理会一直重连（retryStrategy 已关，
      // 但 socket 仍要显式释放），成功时不清理就是每 10 秒泄漏一条连接
      client.disconnect();
    }
  }

  /**
   * 队列：走一次"生产者 → Redis"的完整链路。
   *
   * `getJobCounts` 是只读且极轻的一次调用，但它会真的把命令发到 Redis 上，
   * 所以能证明"这个进程投递 job 的通道是通的"。
   * 注意它比 checkRedis 更严格：不仅要求 Redis 活着，还要求 BullMQ 这个
   * 客户端实例可用（连接池、队列名前缀都参与）。
   */
  private async checkQueue(): Promise<void> {
    await this.queue.getJobCounts('wait');
  }

  /** 跑一项检查：计时 + 超时 + 把异常收敛成结果对象（绝不向外抛） */
  private async runCheck(
    name: CheckName,
    check: () => Promise<void>,
  ): Promise<CheckResult> {
    const startedAt = Date.now();
    try {
      await this.withTimeout(name, check);
      return { ok: true, durationMs: Date.now() - startedAt };
    } catch (err) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: describeError(err),
      };
    }
  }

  /**
   * 给一项检查套上硬超时。
   *
   * 没有超时的健康检查比没有健康检查更糟：依赖"半死不活"（TCP 能连上但
   * 不回包）时，探针会一直挂着。编排系统往往把"探针超时"和"探针失败"
   * 区别对待，一个永远不返回的探针等于把整个判定机制关掉。
   */
  private async withTimeout<T>(
    name: CheckName,
    check: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.options.timeoutMs;
    const work = check();

    // 超时之后这个 promise 可能**还会** reject（连接最终失败）。
    // 先挂一个空 catch 消化掉它，否则那会变成一个无人处理的 rejection，
    // 在 Node 的默认策略下可能直接把进程带走 —— 健康检查绝不该有这种威力。
    work.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `超时（${timeoutMs}ms）` +
              (name === 'queue' ? '，Redis 不可达时队列检查必然超时' : ''),
          ),
        );
      }, timeoutMs);
      // 不阻止进程退出：否则健康检查的定时器会拖住 SIGTERM 关停
      timer.unref?.();
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** 三项被检查的依赖。同时也是失败清单里的取值 */
export type CheckName = 'pg' | 'redis' | 'queue';

export interface CheckResult {
  ok: boolean;
  durationMs: number;
  /** 只在 ok=false 时出现。已脱敏并截断 */
  error?: string;
}

export interface LivenessResult {
  status: 'ok';
  uptimeSec: number;
  pid: number;
  time: string;
}

export interface ReadinessResult {
  /** 'ok' → 200；'error' → 503 */
  status: 'ok' | 'error';
  checkedAt: string;
  durationMs: number;
  checks: Record<CheckName, CheckResult>;
  /** 失败的项，按固定顺序排列。空数组 = 全通 */
  failed: CheckName[];
}

/** 生产实现：连接参数与队列/限流共用同一套 env（见 redis-connection.ts） */
export function createRedisProbe(
  env: NodeJS.ProcessEnv = process.env,
): RedisProbe {
  return new Redis({
    ...buildRedisConnection(env),
    // 懒连接：对象创建时不发起 TCP，第一次 connect() 才连 —— 探针自己控制时机
    lazyConnect: true,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
    // 命令只重试 1 次：健康检查要的是"此刻能不能用"，不是"给它 20 次机会"
    maxRetriesPerRequest: 1,
    // 不在离线队列里攒命令：没连上就立刻失败，而不是排队等重连
    enableOfflineQueue: false,
    // 不自动重连。这个客户端用完即弃，重连由"下一次探针"负责
    retryStrategy: () => null,
  });
}

/** 把任意抛出物收敛成一句能写进响应体的说明 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    // AggregateError（ioredis 多个连接同时失败时会抛它）的 message 常常是空的，
    // 真正有用的信息在 errors 里
    const details =
      err instanceof AggregateError && err.errors.length > 0
        ? `: ${err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`
        : '';
    return truncate(redact(`${err.message}${details}`));
  }
  return truncate(redact(String(err)));
}

/**
 * 脱敏。
 *
 * 健康检查的响应经常是**对外可见**的：负载均衡、K8s 探针、监控系统都会抓，
 * 而且不少项目会把 /health 放进公网白名单。连接类错误里可能带着完整连接串
 * （`postgresql://argus:argus@127.0.0.1:5432/argus`），凭据绝不能出现在
 * 响应体里 —— 哪怕只是内网，日志和监控也常常是比数据库更容易外泄的一份副本。
 */
function redact(message: string): string {
  return message
    .replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//***:***@')
    .replace(/\b(password|passwd|pwd)=[^&\s]+/gi, '$1=***');
}

/** 响应体不该被一条超长错误撑大，也没人会读第 300 个字符 */
function truncate(message: string, max = 300): string {
  return message.length <= max ? message : `${message.slice(0, max)}…`;
}
