import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma, type ErrorEvent } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ERROR_EVENT_JOB,
  ERROR_EVENT_JOB_OPTIONS,
  ERROR_EVENT_QUEUE,
  toJobId,
  type ErrorEventJobData,
} from '../queue/queue.constants';
import { IngestErrorDto } from './dto/ingest-error.dto';

export interface IngestResult {
  event_id: string;
  /** true 表示这条事件之前已收到过（靠 event_id 主键冲突去重） */
  duplicate: boolean;
}

@Injectable()
export class ErrorEventsService {
  private readonly logger = new Logger(ErrorEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ERROR_EVENT_QUEUE) private readonly queue: Queue<ErrorEventJobData>,
  ) {}

  /**
   * 把收到的异常事件**原样**打到控制台。
   *
   * 打的是 `payload` 本身（ValidationPipe 转出来的 DTO 实例），也就是
   * 「校验通过、准备落库」的那份数据 —— 和入库内容是同一来源，不做任何裁剪。
   * stack 全文、面包屑全部条目，一个字段都不省。
   *
   * 用 JSON.stringify(payload, null, 2) 而不是手写模板：
   *   ① 不会漏字段 —— 以后 SDK 加字段，这里自动就有
   *   ② 缩进格式，长对象也能读
   * 头部那行是 JSON 的总长度，用来判断这条 payload 有多大（stack 长时会到几 KB）。
   *
   * 注意：DTO 里没声明的字段已经被 ValidationPipe 的 whitelist 剥掉了，
   * 所以这里看不到"客户端多发的垃圾字段" —— 那属于被丢弃的数据，不是收到的数据。
   */
  private logIncoming(payload: IngestErrorDto): void {
    let pretty: string;
    try {
      pretty = JSON.stringify(payload, null, 2);
    } catch (err) {
      // DTO 是普通对象，正常不会走到这里；真循环引用了也不能让日志把请求搞挂
      this.logger.warn(`收到异常事件，但序列化失败: ${String(err)}`);
      return;
    }

    this.logger.log(['', `收到异常事件（JSON ${pretty.length} 字符）`, '---', pretty, '---'].join('\n'));
  }

  /**
   * 写入一条异常事件。同一 event_id 重复上报不会产生第二条记录。
   *
   * 去重实现和 Mongoose 时代的区别（语义不变，写法变了）：
   *   旧写法是 findOneAndUpdate + upsert + includeResultMetadata，靠返回的
   *   updatedExisting 判断「这条是插进去的，还是本来就有的」。
   *   Prisma 的 upsert 不告诉你命中与否，所以改成 create + 捕获主键冲突：
   *   撞主键（P2002）就等于「之前已经收到过」，结果与旧实现一致，且只发一条 SQL。
   *
   * W3 起多了一步：**写库成功后**往归并队列投一条 job（见 enqueue）。
   * 顺序不能反 —— 先入队的话，Worker 可能比写库更快地拿到一个还查不到的主键。
   * 两步之间刻意不做跨系统事务（Redis 与 PG 之间没有可靠的两阶段提交，硬凑出来的
   * "事务"只会在其中一边挂着时留下更难查的状态）。代价是"入库成功但入队失败"，
   * 由补扫任务兜住。
   */
  async ingest(payload: IngestErrorDto, projectId: string): Promise<IngestResult> {
    this.logIncoming(payload);

    try {
      await this.prisma.errorEvent.create({ data: this.toRow(payload, projectId) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // event_id 就是主键，所以撞唯一约束只可能是"这条事件重复上报"
        if (err.code === 'P2002') {
          this.logger.debug(`事件已存在，跳过: ${payload.event_id}`);
          return { event_id: payload.event_id, duplicate: true };
        }
        // P2000 是值超出列宽。DTO 已经限了每个字段的长度，这里兜住两边漂移的情况
        // （比如以后 schema 收窄、DTO 忘了同步），否则用户拿到的是 500 而不是 400
        if (err.code === 'P2000') {
          throw new BadRequestException('字段长度超出数据库限制');
        }
      }
      throw err;
    }

    await this.enqueue(payload.event_id);

    return { event_id: payload.event_id, duplicate: false };
  }

  /**
   * 投递一条归并任务。
   *
   * ── jobId 用 event_id ──────────────────────────────────────────────────
   * 队列里同 jobId 的 job 还在时，BullMQ 会**静默忽略**这次 add（不报错、也不新建，
   * 见 addStandardJob-9.js 的 handleDuplicatedJob），这是防重复入队的第一道闸。
   * 注意它是"静默"的：别指望靠 catch 判断有没有入队成功。
   * 形状不合法的 id（纯数字 / 含冒号）由 toJobId 先映射成合法形状。
   *
   * ── 失败为什么只记日志、不往上抛 ────────────────────────────────────────
   * 事件已经落库了，真相保住了；入队失败只意味着"暂时没人处理它"，由补扫任务兜住。
   * 反过来若抛出去：SDK 收到 500 会重试，而重试撞主键会被判成 duplicate、
   * 在下面那条 duplicate 分支里直接返回 —— 照样不会入队，还多绕一圈。
   *
   * ── 只有新事件才入队 ───────────────────────────────────────────────────
   * duplicate 分支不入队：这条事件上一次已经入过队（jobId 相同，去重窗口内会被
   * 静默忽略），真要是上次入队失败，补扫会按 processed_at IS NULL 把它捞回来。
   */
  private async enqueue(eventId: string): Promise<void> {
    try {
      await this.queue.add(
        ERROR_EVENT_JOB,
        { eventId },
        { ...ERROR_EVENT_JOB_OPTIONS, jobId: toJobId(eventId) },
      );
    } catch (err) {
      this.logger.error(
        `入队失败，事件已入库但尚未归并（等补扫兜住）: event_id=${eventId} 原因=${String(err)}`,
      );
    }
  }

  /**
   * DTO → 入库行：原始字段保留，同时补一份 exception 结构，
   * 让「原始契约」和「后续归一化要用的结构」并存。
   *
   * 与 Mongoose 时代的区别：那时 sdk / exception.* 是嵌套对象，原样存进 Mongo 文档；
   * PG 里它们被拍平成列，所以这里要把嵌套展开，字段名换成 schema 里的 camelCase 列名。
   *
   * 缺值统一落 null 而不是 ''：列可空，"SDK 没发这个字段"和"发了个空串"是两件事，
   * 用空串兜底会把后者的信息也抹掉。
   */
  private toRow(payload: IngestErrorDto, projectId: string): Prisma.ErrorEventUncheckedCreateInput {
    return {
      eventId: payload.event_id,
      // 所属项目：由控制器从上报公钥反查得到，客户端无从指定（TC-05）
      projectId,
      // DTO 的取值联合与 schema 的 Mechanism enum 一一对应（onerror / unhandledrejection / resource），
      // 所以这里直接赋，不需要转换或做映射表
      mechanism: payload.mechanism,
      type: payload.type,
      message: payload.message,
      stack: payload.stack ?? null,
      source: payload.source ?? null,
      timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      url: payload.url ?? '',
      userAgent: payload.user_agent ?? '',
      sdkName: payload.sdk?.name ?? null,
      sdkVersion: payload.sdk?.version ?? null,
      // 版本与环境：M3 的 Sourcemap 按 release 找 map（FR-3.4）。
      // 这里漏了不会报任何错，只会让 error_events.release 恒为 NULL ——
      // 直到做「受控重算」时才发现历史数据全都无从匹配
      release: payload.release ?? null,
      environment: payload.environment ?? null,
      // exception.* 是给读取侧归一化/指纹用的同一份数据（原始契约在上面那几列）
      exceptionType: payload.type,
      exceptionValue: payload.message,
      exceptionMechanism: payload.mechanism,
      // raw 原样保留：归一化与指纹都在读取侧做，写入侧不做加工
      stacktraceRaw: payload.stack ?? null,
      // stacktraceFrames 有意不写：frames 由读取侧解析回填。现在写 null 是"没有 frames"，
      // 写 [] 是"解析过且为空"，两个都不是当前事实 —— 不写，列就是 SQL NULL。
      //
      // 面包屑原样落库：形状是 SDK 的事，读取侧（看板时间线 FR-8.6）再渲染。
      // 用展开而不是 `breadcrumbs: payload.breadcrumbs ?? null`：Json? 列不能直接写 null
      // （类型是 NullableJsonNullValueInput | InputJsonValue，且 Prisma.JsonNull 存的是
      // JSON 的 null、Prisma.DbNull 才是 SQL NULL）。字段整个不出现，语义最干净。
      ...(payload.breadcrumbs
        ? { breadcrumbs: payload.breadcrumbs as Prisma.InputJsonValue }
        : {}),
    };
  }

  /**
   * 分页查询异常事件，按事件时间倒序。
   *
   * 响应形状（字段统一 snake_case，与 SDK 上报契约、ingest 响应保持一致）：
   * {
   *   items: [{
   *     event_id, mechanism, type, message, stack, source,
   *     timestamp, received_at, url, user_agent,
   *     sdk_name, sdk_version,
   *     exception_type, exception_value, exception_mechanism,
   *     stacktrace_raw, stacktrace_frames,
   *     user_id, session_id, release, environment,
   *     tags, extra, breadcrumbs,
   *   }],
   *   total, page, pageSize,
   * }
   *
   * 两个刻意的选择：
   *   ① orderBy 用 timestamp 而不是 received_at —— 表上只有
   *      @@index([timestamp(sort: Desc)])，换字段就是全表 sort
   *   ② 列表与总数放进同一个 $transaction —— 同一事务快照，并发写入时不会
   *      出现"total=10 但翻到第 2 页是空的"这种自相矛盾
   *
   * 过渡接口：M4-S2 起 projectId 必填（来自查询参数，S4 后改由 JWT 决定）。
   * 另注：count() 在几十万行时是全表扫描，M2 之后趋势类查询改读预聚合表。
   */
  async listErrorEvents(projectId: string, page: number, pageSize: number) {
    const where = { projectId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.errorEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.errorEvent.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toApiRow(row)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 数据库行 → 接口响应。
   *
   * 为什么不直接 return rows：Prisma 返回的是内部模型形状，以后给表加了仅供
   * 内部使用的列，它会自动出现在响应里。字段在这里显式列出 = 接口契约由这里定。
   *
   * 三处不用特殊处理：
   *   · Date 经 JSON.stringify 自动序列化成 ISO 8601 UTC 字符串（符合 SRS §8）
   *   · Json 列的 null 保持 null，不会被抹成缺字段
   *   · 本表没有 BigInt 列，不会踩 JSON.stringify 不支持 BigInt 的坑
   */
  private toApiRow(row: ErrorEvent) {
    return {
      event_id: row.eventId,
      mechanism: row.mechanism,
      type: row.type,
      message: row.message,
      stack: row.stack,
      source: row.source,
      timestamp: row.timestamp,
      received_at: row.receivedAt,
      url: row.url,
      user_agent: row.userAgent,
      sdk_name: row.sdkName,
      sdk_version: row.sdkVersion,
      exception_type: row.exceptionType,
      exception_value: row.exceptionValue,
      exception_mechanism: row.exceptionMechanism,
      stacktrace_raw: row.stacktraceRaw,
      stacktrace_frames: row.stacktraceFrames,
      user_id: row.userId,
      session_id: row.sessionId,
      release: row.release,
      environment: row.environment,
      tags: row.tags,
      extra: row.extra,
      breadcrumbs: row.breadcrumbs,
      /// 归并到的问题 ID，NULL = 尚未归并（M1 阶段恒为 NULL）。
      /// 看板拿它多显示一列，但**默认列表不做任何过滤** ——
      /// 一旦按 group_id IS NULL 过滤，Worker 归并得越成功、看板就越空。
      group_id: row.groupId,
      // processed_at 有意不暴露：它是 Worker 的幂等闸门（内部进度），
      // 不是给用户看的"已读"标记。暴露它等于让处理进度决定用户能看到什么。
    };
  }
}
