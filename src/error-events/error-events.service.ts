import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IngestErrorDto } from './dto/ingest-error.dto';

export interface IngestResult {
  event_id: string;
  /** true 表示这条事件之前已收到过（靠 event_id 主键冲突去重） */
  duplicate: boolean;
}

@Injectable()
export class ErrorEventsService {
  private readonly logger = new Logger(ErrorEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

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
   */
  async ingest(payload: IngestErrorDto): Promise<IngestResult> {
    this.logIncoming(payload);

    try {
      await this.prisma.errorEvent.create({ data: this.toRow(payload) });
      return { event_id: payload.event_id, duplicate: false };
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
  private toRow(payload: IngestErrorDto): Prisma.ErrorEventCreateInput {
    return {
      eventId: payload.event_id,
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
}
