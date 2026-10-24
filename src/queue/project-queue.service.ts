import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { buildRedisConnection } from './redis-connection';
import { ERROR_EVENT_QUEUE, projectQueueName, type ErrorEventJobData } from './queue.constants';

/**
 * 按项目取队列（M4-S7）。
 *
 * ── 懒创建 + 缓存 ────────────────────────────────────────────────────────
 * 上报热路径上不能每次都 `new Queue(...)` —— 那会为每个请求建一条 ioredis 连接。
 * 所以按队列名缓存，同一个项目的后续上报复用同一个 Queue 实例。
 *
 * ── 为什么从 base 队列上拷连接配置 ──────────────────────────────────────
 * `queue.opts.connection` 就是 `BullModule.forRootAsync` 里那份配置。拷它而不是
 * 重新读 env，是为了让"生产者写的队列"和"消费者读的队列"必然连同一个 Redis。
 *
 * ── 为什么只做生产者 ────────────────────────────────────────────────────
 * 消费侧需要每个项目一个 Worker（阻塞连接 + 独立并发），那是
 * `grouping/project-worker.manager.ts` 的事，而且只在 worker 进程里跑。
 */
@Injectable()
export class ProjectQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(ProjectQueueService.name);
  private readonly queues = new Map<string, Queue<ErrorEventJobData>>();

  constructor(@InjectQueue(ERROR_EVENT_QUEUE) base: Queue) {
    // base 队列本身的连接配置就是全局配置；拿不到时退回读 env（正常走不到）
    this.connection = base.opts.connection ?? buildRedisConnection();
  }

  private readonly connection: NonNullable<Queue['opts']['connection']>;

  /** 取（必要时创建）某个项目的队列 */
  queueFor(projectId: string): Queue<ErrorEventJobData> {
    const name = projectQueueName(projectId);
    let queue = this.queues.get(name);
    if (queue === undefined) {
      queue = new Queue<ErrorEventJobData>(name, { connection: this.connection });
      queue.on('error', (err: Error) => {
        this.logger.warn(`队列「${name}」连接异常: ${err.message}`);
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * 所有**已创建**的队列（projectId + Queue 实例）。
   *
   * 给指标采集用（M6-7 的队列积压）。只返回被上报链路碰过的队列：
   * 没有流量的项目不该为了一个数字凭空多一条 Redis 连接，指标里它显示为
   * "没有数据"就够了。
   *
   * projectId 从队列名反解（`error-events-<uuid>`）。Map 的 key 就是队列名，
   * 再存一份 projectId 等于维护两份真相，改名时迟早对不上。
   */
  entries(): Array<{ projectId: string; queue: Queue<ErrorEventJobData> }> {
    const prefix = `${ERROR_EVENT_QUEUE}-`;
    return [...this.queues.entries()].map(([name, queue]) => ({
      projectId: name.startsWith(prefix) ? name.slice(prefix.length) : name,
      queue,
    }));
  }

  async onModuleDestroy(): Promise<void> {    await Promise.all(
      [...this.queues.values()].map((queue) =>
        queue.close().catch((err: unknown) => {
          this.logger.warn(`关闭队列失败: ${String(err)}`);
        }),
      ),
    );
    this.queues.clear();
  }
}
