import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectQueueService } from '../queue/project-queue.service';
import {
  ingestEventsTotal,
  ingestRejectedTotal,
  queueJobs,
  registry,
  setQueueCollector,
} from './metrics.registry';

/**
 * 一次抓取要看哪些状态。
 *
 * 只取这四个：waiting（还没被消费）、active（正在处理）、delayed（重试等待中）、
 * failed（重试耗尽）。completed 不在其中——它是"历史累计完成数"，
 * 每次抓取都去数一遍只会白烧 Redis（而且这个数由处理速率指标覆盖）。
 */
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * 指标采集（M6-7）。
 *
 * 只做三件事：
 *   ① 把进程自身的 CPU / 内存 / 事件循环延迟交给 prom-client 的默认采集
 *   ② 暴露两个计数器给上报链路调用
 *   ③ 每次 Prometheus 来抓时，现场去问 BullMQ「队列里现在堆了多少」
 *
 * ── 为什么队列长度用 collect() 而不是定时器 ─────────────────────────────
 * 队列长度是"此刻的状态"，不是"发生过的事件"。用 setInterval 定时刷新，
 * 要么刷新太频繁（白烧 Redis），要么太稀（抓到的数字是过期的）。
 * Gauge 的 collect 回调是**抓取时才发现场去查**：有人要才花这次钱，
 * 没人抓就完全不产生开销，也不用管理定时器生命周期（worker 优雅关闭时
 * 忘记 clearInterval 是经典泄漏）。
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);

  /**
   * 队列积压的 Gauge **定义在 registry 里**（模块级单例），这里只负责把
   * "怎么读队列"接上去。原因见 registry 里 setQueueCollector 的注释：
   * Gauge 同名重复注册会直接抛异常，放在 service 里每个实例都会注册一次。
   */
  constructor(
    private readonly queues: ProjectQueueService,
    // 项目名单来自数据库，而不是"已经创建过队列的那些项目"——
    // 理由见 collectQueues 的注释
    private readonly prisma: PrismaService,
  ) {
    setQueueCollector(() => this.collectQueues());
  }

  onModuleInit(): void {
    // 进程级默认指标：CPU、内存、GC、事件循环延迟、句柄数……
    // 一行代码换十几个标准指标，没有理由不拿
    collectDefaultMetrics({ register: registry });
  }

  /** 上报入库成功后调用（重复上报不算，见 registry 里的说明） */
  recordIngest(projectId: string): void {
    ingestEventsTotal.inc({ project_id: projectId });
  }

  /** 上报被拒时调用。reason 是有限枚举，不要拼动态字符串进去 */
  recordRejected(projectId: string, reason: string): void {
    ingestRejectedTotal.inc({ project_id: projectId, reason });
  }

  /**
   * 抓取时现场读队列长度。
   *
   * ── 为什么项目名单来自 projects 表，而不是来自"已经建过队列的项目" ──────
   * 之前的实现遍历 `ProjectQueueService` 里已缓存的队列（那些"有人上报过"的
   * 项目）。后果是一个安静的项目（这段时间没人报错）在指标里**整个消失**：
   *   · Grafana 上前端的线断掉，看起来像"项目被删了"或"指标链路挂了"
   *   · `sum(argus_queue_jobs)` 会**变小**，让人误以为积压缓解了
   *   · 告警规则 `argus_queue_jobs > 100` 在项目安静时没有序列，表达式不返回任何值
   * 改成从 `projects where is_active` 枚举之后，**每个启用项目恒定有 4 条序列**，
   * 没有积压就是 0 —— 0 和"没有这条序列"在 Prometheus 里是两件完全不同的事。
   *
   * 代价：项目数 × 1 次 Redis 往返（20 个项目 = 20 次 `getJobCounts`）。
   * 抓取间隔通常 15~30 秒，这点开销可以接受；换来的是"指标不会说谎"。
   *
   * ⚠️ 这里**必须吞掉异常**：Redis 抖一下如果让整个 /metrics 返回 500，
   * Prometheus 会把这个实例标成 down —— 一个"看健康"的接口反而制造了
   * 一次"服务不可用"的告警，比没有指标更糟。
   */
  private async collectQueues(): Promise<void> {
    // 先清掉上一轮的标签组合：项目被停用/删除后，旧序列不该永远留在指标里
    queueJobs.reset();

    let projects: Array<{ id: string }>;
    try {
      projects = await this.prisma.project.findMany({
        where: { isActive: true },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
    } catch (err) {
      // 连项目列表都读不到（PG 挂了）：这一轮没有任何序列，但 /metrics 仍要能返回
      this.logger.warn(`采集队列指标失败（读项目列表）：${String(err)}`);
      return;
    }

    for (const { id } of projects) {
      try {
        const counts = await this.queues.queueFor(id).getJobCounts(...QUEUE_STATES);
        for (const state of QUEUE_STATES) {
          queueJobs.set({ project_id: id, state }, counts[state] ?? 0);
        }
      } catch (err) {
        // 单个项目的队列读失败：仍然暴露 0，否则该项目在图上会"消失"
        // （消失比归零更容易被误读成"项目没了"）
        this.logger.warn(`采集队列指标失败（project=${id}）：${String(err)}`);
        for (const state of QUEUE_STATES) {
          queueJobs.set({ project_id: id, state }, 0);
        }
      }
    }
  }
}

