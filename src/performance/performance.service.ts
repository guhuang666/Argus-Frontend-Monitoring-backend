import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type PerformanceMetric } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { IngestPerfDto } from './dto/ingest-perf.dto';

export interface IngestPerfResult {
  event_id: string;
  /** true 表示这条事件之前已收到过（靠 event_id 主键冲突去重） */
  duplicate: boolean;
}

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    // 会话写入（M5）：性能上报同时是"看了一个页面"的证据，给 page_views +1
    private readonly sessions: SessionsService,
  ) {}

  /**
   * 把收到的性能事件**原样**打到控制台。
   *
   * 打的是 `payload` 本身（ValidationPipe 转出来的 DTO 实例），也就是
   * 「校验通过、准备落库」的那份数据 —— 和入库内容是同一来源，不做任何裁剪。
   *
   * 用 JSON.stringify(payload, null, 2) 而不是手写模板：
   *   ① 不会漏字段 —— 以后 SDK 加字段，这里自动就有
   *   ② 缩进格式，长对象也能读
   * 头部那行是 JSON 的总长度，用来判断这条 payload 有多大。
   *
   * 注意：DTO 里没声明的字段已经被 ValidationPipe 的 whitelist 剥掉了，
   * 所以这里看不到"客户端多发的垃圾字段" —— 那属于被丢弃的数据，不是收到的数据。
   */
  private logIncoming(payload: IngestPerfDto): void {
    let pretty: string;
    try {
      pretty = JSON.stringify(payload, null, 2);
    } catch (err) {
      // DTO 是普通对象，正常不会走到这里；真循环引用了也不能让日志把请求搞挂
      this.logger.warn(`收到性能事件，但序列化失败: ${String(err)}`);
      return;
    }

    this.logger.log(['', `收到性能事件（JSON ${pretty.length} 字符）`, '---', pretty, '---'].join('\n'));
  }

  /**
   * 写入一条性能指标。同一 event_id 重复上报不会产生第二条记录。
   *
   * 去重实现和 Mongoose 时代的区别（语义不变，写法变了）：
   *   旧写法是 findOneAndUpdate + upsert + includeResultMetadata，靠返回的
   *   updatedExisting 判断「这条是插进去的，还是本来就有的」。
   *   Prisma 的 upsert 不告诉你命中与否，所以改成 create + 捕获主键冲突：
   *   撞主键（P2002）就等于「之前已经收到过」，结果与旧实现一致，且只发一条 SQL。
   *
   * 为什么不用 upsert：它对重复投递是静默更新，接口就没法再回 duplicate 了。
   * 为什么不用先 findUnique 再 create：两次查询之间有竞态，并发重复上报两个都会走到 create。
   */
  async ingest(payload: IngestPerfDto, projectId: string): Promise<IngestPerfResult> {
    this.logIncoming(payload);

    try {
      await this.prisma.performanceMetric.create({ data: this.toRow(payload, projectId) });

      // 会话写入（M5）：一次性能上报 = 一次页面加载 → page_views +1。
      // 这是**现有 PV 口径的来源**（见 Session 模型注释的"已知近似"）。
      // 注意 performanceMetric.create 上面没有赋值，所以这里不看它的返回值。
      await this.sessions.touch({
        projectId,
        sessionId: payload.session_id,
        userKey: payload.user?.id ?? null,
        at: payload.timestamp ? new Date(payload.timestamp) : new Date(),
        hasError: false,
        pageViews: 1,
      });

      return { event_id: payload.event_id, duplicate: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // event_id 就是主键，所以撞唯一约束只可能是"这条事件重复投递"
        if (err.code === 'P2002') {
          this.logger.debug(`性能事件已存在，跳过: ${payload.event_id}`);
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
  }

  /**
   * DTO → 入库行。
   *
   * 与 Mongoose 时代的区别：那时 sdk / metrics / attribution / device 是嵌套对象，
   * 原样存进 Mongo 文档；PG 里这些嵌套被拍平成列，所以要在这里展开一次。
   *
   * 三件必须做的事：
   *   ① 缺值统一落 null，不要留 undefined —— 列本来就可空，"没数据"就是 NULL
   *   ② 时间字符串转 Date：DTO 传进来的是 ISO 字符串，Prisma 不接受字符串时间
   *   ③ receivedAt 不写：交给 schema 里的 @default(now())，别在两个地方各写一份时间
   *
   * 注意 deviceViewport / deviceDpr 不再用 '' 和 0 兜底（旧 Mongoose 代码是那么写的）：
   * 和 lcp/cls/inp 同一条纪律 —— 没测到 ≠ 测得 0，用 0 冒充会让看板分不出这两种情况。
   */
  private toRow(
    payload: IngestPerfDto,
    projectId: string,
  ): Prisma.PerformanceMetricUncheckedCreateInput {
    const { metrics, attribution, device } = payload;
    return {
      eventId: payload.event_id,
      // 所属项目：由控制器从上报公钥反查得到，客户端无从指定（TC-05）
      projectId,
      timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      url: payload.url ?? '',
      userAgent: payload.user_agent ?? '',
      sdkName: payload.sdk?.name ?? null,
      sdkVersion: payload.sdk?.version ?? null,
      // 用 ?? null 而不是 ?? 0：没测到就是没测到，别用 0 冒充
      lcp: metrics.lcp ?? null,
      cls: metrics.cls ?? null,
      inp: metrics.inp ?? null,
      lcpElement: attribution?.lcp_element ?? null,
      inpTarget: attribution?.inp_target ?? null,
      inpElement: attribution?.inp_element ?? null,
      inpPhase: attribution?.inp_phase ?? null,
      navigationType: payload.navigation_type ?? null,
      deviceViewport: device?.viewport ?? null,
      deviceDpr: device?.dpr ?? null,
      connection: payload.connection ?? null,
      // 用户标识。列早就存在，缺的一直是上行链路（DTO 不收 → 这里恒为 NULL）。
      // SDK 拿不到身份时是 null，按匿名处理：不影响指标，只是不参与用户维度统计。
      userId: payload.user?.id ?? null,
      // 会话（M5）：列早就存在，缺的一直是上行链路；真正写 sessions 表在 ingest 里
      sessionId: payload.session_id ?? null,
    };
  }

  /**
   * 分页查询性能指标，按事件时间倒序。
   *
   * 响应形状（字段统一 snake_case）：
   * {
   *   items: [{
   *     event_id, timestamp, received_at, url, user_agent,
   *     sdk_name, sdk_version,
   *     lcp, cls, inp,
   *     lcp_element, inp_target, inp_element, inp_phase,
   *     navigation_type, device_viewport, device_dpr, connection,
   *     user_id, session_id, release, environment,
   *   }],
   *   total, page, pageSize,
   * }
   *
   * 两个刻意的选择：
   *   ① orderBy 用 timestamp —— 表上有 @@index([timestamp(sort: Desc)])
   *      与 @@index([url, timestamp(sort: Desc)])，换字段就要全表 sort
   *   ② 列表与总数放进同一个 $transaction —— 同一事务快照，两者不会对不上
   *
   * 注意 lcp / cls / inp 为 null 表示**这一项没测到**（不是 0）：
   * 读取侧（看板分位数）必须跳过 null 而不是当 0 参与计算，否则"没数据"
   * 会被算成"性能完美"。
   *
   * 过渡接口：M4-S2 起 projectId 必填（来自查询参数，S4 后改由 JWT 决定）。
   */
  async listPerformanceMetrics(projectId: string, page: number, pageSize: number) {
    const where = { projectId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.performanceMetric.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.performanceMetric.count({ where }),
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
   * Date 经 JSON.stringify 自动序列化成 ISO 8601 UTC 字符串（符合 SRS §8）；
   * 本表没有 BigInt 列，不会踩 JSON.stringify 不支持 BigInt 的坑。
   */
  private toApiRow(row: PerformanceMetric) {
    return {
      event_id: row.eventId,
      timestamp: row.timestamp,
      received_at: row.receivedAt,
      url: row.url,
      user_agent: row.userAgent,
      sdk_name: row.sdkName,
      sdk_version: row.sdkVersion,
      lcp: row.lcp,
      cls: row.cls,
      inp: row.inp,
      lcp_element: row.lcpElement,
      inp_target: row.inpTarget,
      inp_element: row.inpElement,
      inp_phase: row.inpPhase,
      navigation_type: row.navigationType,
      device_viewport: row.deviceViewport,
      device_dpr: row.deviceDpr,
      connection: row.connection,
      user_id: row.userId,
      session_id: row.sessionId,
      release: row.release,
      environment: row.environment,
    };
  }
}
