import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { WorkerMetricsService } from '../metrics/worker-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildRedisConnection } from '../queue/redis-connection';
import { projectQueueName, type ErrorEventJobData } from '../queue/queue.constants';
import { ErrorEventProcessor } from './error-event.processor';

/**
 * 每个项目的消费并发度。
 *
 * ── 为什么是"每项目"而不是"全局" ────────────────────────────────────────
 * 这正是 S7 的核心：单队列时 5 个并发槽位会被先到的项目占满，后到的项目
 * 只能等。改成每项目 2 个之后，A 项目最多占用 2 个槽位，剩下的算力
 * 天然留给别人 —— **隔离不是靠调度策略，是靠资源配额分开**。
 *
 * 2 而不是 5：项目多了之后总并发 = 项目数 × 2，对 PG 连接池压力更大。
 * 20 个项目就是 40 并发，需要相应调大连接池（见 .env 的 DATABASE_URL 参数）。
 */
const PER_PROJECT_CONCURRENCY = 2;

/**
 * 多久扫一次项目表。
 *
 * 新建项目后最多这么久才开始消费它的队列。30 秒是"演示时不用重启 worker"
 * 和"不会频繁打库"之间的折中。想要即时生效就得让项目创建接口去通知 worker
 * （跨进程），那是另一个复杂度级别。
 */
const SYNC_INTERVAL_MS = 30_000;

/**
 * 按项目创建 / 回收 Worker（M4-S7 / FR-6.6）。
 *
 * ── 它解决的问题 ────────────────────────────────────────────────────────
 * 单队列 + 单 Worker 池时，A 项目灌 10 万条进来，B 项目的 3 条排在队尾 ——
 * B 付了钱，却因为 A 被攻击而看不到自己的报错。
 * 现在每个项目一条队列（`error-events-<projectId>`）+ 一个独立 Worker，
 * A 的积压只影响 A。
 *
 * ── 连接成本（必须知道的代价）───────────────────────────────────────────
 * BullMQ 的每个 Worker 需要**一条独立的阻塞连接**（外加一条普通连接），
 * 所以 N 个项目 ≈ 2N 条 Redis 连接。项目上限是 20（建项目时加的约束），
 * 也就是约 40 条 —— 对 Redis 的 10000 上限来说很宽松。
 *
 * ── 为什么不用一个 Worker 监听多队列 ────────────────────────────────────
 * BullMQ 的 Worker 一次只能监听一个队列名，这是它的设计（阻塞式 BRPOPLPUSH）。
 * 想要"一个 Worker 轮询多队列"就得自己写调度，反而更复杂。
 */
@Injectable()
export class ProjectWorkerManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectWorkerManager.name);
  private readonly workers = new Map<string, Worker<ErrorEventJobData>>();
  /** projectId → 项目名，只用于日志好读 */
  private readonly names = new Map<string, string>();
  private readonly connection: ConnectionOptions = buildRedisConnection();

  private timer?: NodeJS.Timeout;
  /** 防止上一轮同步还没跑完（DB 慢时）又叠一轮 */
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: ErrorEventProcessor,
    // 指标（M6-7）：统计的是"进程处理了多少 job"，与业务无关，
    // 所以挂在 manager 这一层（所有 Worker 的唯一创建点），而不是处理器里
    private readonly metrics: WorkerMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await Promise.all([...this.workers.values()].map((worker) => this.closeQuietly(worker)));
    this.workers.clear();
  }

  /**
   * 现在在监听哪些项目（给启动日志用）。
   * 返回副本，调用方改不到内部状态。
   */
  listens(): Array<{ projectId: string; name: string }> {
    return [...this.workers.keys()].map((projectId) => ({
      projectId,
      name: this.names.get(projectId) ?? projectId,
    }));
  }

  /**
   * 对齐"当前应该有哪些队列"和"已经在跑的 Worker"。
   *
   * 两件事都做：
   *   · 新项目 → 建 Worker
   *   · 被删除 / 停用的项目 → 关掉 Worker（否则它会一直空转并占着连接）
   *
   * 后一件事容易被忘，但它是"Worker 泄漏"的唯一防线：项目删了 Worker 还在，
   * 进程里的 Map 会越攒越大，重启前都不会释放。
   */
  private async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const projects = await this.prisma.project.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });
      const alive = new Set(projects.map((project) => project.id));

      for (const project of projects) {
        this.names.set(project.id, project.name);
        if (!this.workers.has(project.id)) {
          this.spawn(project.id, project.name);
        }
      }

      for (const [projectId, worker] of this.workers) {
        if (alive.has(projectId)) continue;
        this.workers.delete(projectId);
        const name = this.names.get(projectId) ?? projectId;
        this.names.delete(projectId);
        // 先摘出 Map 再关：关的过程中如果 sync 又被触发，不会重复关同一个 Worker
        await this.closeQuietly(worker);
        this.logger.log(`项目「${name}」已停用或删除，关闭其消费队列`);
      }
    } catch (err) {
      // 同步失败不能杀掉 worker 进程：已经建好的 Worker 还在正常工作，
      // 下一轮 sync 会补齐新增的项目
      this.logger.error(`同步项目队列失败（${SYNC_INTERVAL_MS / 1000}s 后重试）: ${String(err)}`);
    } finally {
      this.syncing = false;
    }
  }

  private spawn(projectId: string, name: string): void {
    const queueName = projectQueueName(projectId);

    const worker = new Worker<ErrorEventJobData>(
      queueName,
      // 处理器是个普通方法：S7 之后消费逻辑不再和"监听哪条队列"绑定
      (job: Job<ErrorEventJobData>) => this.processor.handle(job),
      { connection: this.connection, concurrency: PER_PROJECT_CONCURRENCY },
    );

    // 失败处理（含转 DLQ）留在 processor 里，这里只负责转发 ——
    // 同一个逻辑被 N 个 Worker 复用，不该复制 N 份
    worker.on('failed', (job, err) => {
      // 失败**每次尝试**都记一笔（含还会重试的），这样 failed/succeeded
      // 的比值才等于重试率；只记"最终失败"会把重试期间的问题藏起来
      this.metrics.recordAttempt('failed');
      void this.processor.onFailed(job, err);
    });

    // 成功处理完一个 job（含幂等跳过的情况：那也算"处理过了"；
    // 真正的"重复投递"由处理器内部识别，指标层不重复判断）
    worker.on('completed', () => {
      this.metrics.recordAttempt('succeeded');
    });

    // 不挂这个监听也不会崩（bullmq 的 emit 兜了 try/catch），
    // 但那样错误会绕过 Nest 日志体系，排查时看不见
    worker.on('error', (err: Error) => {
      this.logger.warn(`[${name}] Worker 异常: ${err.message}`);
    });

    this.workers.set(projectId, worker);
    this.logger.log(
      `已启动消费队列「${queueName}」（项目「${name}」，并发 ${PER_PROJECT_CONCURRENCY}）`,
    );
  }

  private async closeQuietly(worker: Worker<ErrorEventJobData>): Promise<void> {
    try {
      // close() 会等正在处理的 job 跑完再退，不会做到一半被砍
      await worker.close();
    } catch (err) {
      this.logger.warn(`关闭 Worker 失败: ${String(err)}`);
    }
  }
}
