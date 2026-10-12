import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IngestErrorDto } from './dto/ingest-error.dto';
import { ErrorEvent, ErrorEventDocument } from './error-event.schema';

export interface IngestResult {
  event_id: string;
  /** true 表示这条事件之前已收到过（靠 event_id 唯一索引去重） */
  duplicate: boolean;
}

@Injectable()
export class ErrorEventsService {
  private readonly logger = new Logger(ErrorEventsService.name);

  constructor(
    @InjectModel(ErrorEvent.name)
    private readonly model: Model<ErrorEventDocument>,
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

  /** 写入一条异常事件。同一 event_id 重复上报不会产生第二条记录 */
  async ingest(payload: IngestErrorDto): Promise<IngestResult> {
    this.logIncoming(payload);

    try {
      const result = await this.model.findOneAndUpdate(
        { event_id: payload.event_id },
        { $setOnInsert: this.toDocument(payload) },
        { upsert: true, returnDocument: 'after', includeResultMetadata: true, setDefaultsOnInsert: true },
      );

      const duplicate = result.lastErrorObject?.updatedExisting === true;
      if (duplicate) this.logger.debug(`事件已存在，跳过: ${payload.event_id}`);

      return { event_id: payload.event_id, duplicate };
    } catch (err) {
      // Schema 校验失败（缺 type、mechanism 非法等）属于客户端问题，返回 400 而不是 500
      if (err instanceof Error && err.name === 'ValidationError') {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * DTO 是扁平结构，这里把原始字段保留，同时补一份 exception 嵌套结构，
   * 让「原始契约」和「后续归一化要用的结构」并存。
   */
  private toDocument(payload: IngestErrorDto): Record<string, unknown> {
    return {
      event_id: payload.event_id,
      mechanism: payload.mechanism,
      type: payload.type,
      message: payload.message,
      stack: payload.stack ?? '',
      source: payload.source,
      timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      url: payload.url ?? '',
      user_agent: payload.user_agent ?? '',
      sdk: payload.sdk ?? {},
      // 面包屑原样落库：形状是 SDK 的事，读取侧（看板时间线 FR-8.6）再渲染
      breadcrumbs: payload.breadcrumbs ?? [],
      exception: {
        type: payload.type,
        value: payload.message,
        mechanism: payload.mechanism,
        // raw 原样保留：归一化与指纹都在读取侧做，写入侧不做加工
        stacktrace: { raw: payload.stack ?? '', frames: [] },
      },
    };
  }
}
