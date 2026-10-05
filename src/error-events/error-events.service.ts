import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ErrorEvent, ErrorEventDocument } from './error-event.schema';

export interface IngestResult {
  event_id: string;
  /** true 表示这条事件之前已收到过（靠 event_id 唯一索引去重） */
  duplicate: boolean;
}

/** SDK 发上来的原始事件体 */
export interface IngestPayload {
  event_id: string;
  mechanism: 'onerror' | 'unhandledrejection';
  type: string;
  message: string;
  stack?: string;
  source?: string;
  timestamp?: string;
  url?: string;
  user_agent?: string;
  sdk?: { name: string; version: string };
}

@Injectable()
export class ErrorEventsService {
  private readonly logger = new Logger(ErrorEventsService.name);

  constructor(
    @InjectModel(ErrorEvent.name)
    private readonly model: Model<ErrorEventDocument>,
  ) {}

  /** 写入一条异常事件。同一 event_id 重复上报不会产生第二条记录 */
  async ingest(payload: IngestPayload): Promise<IngestResult> {
    try {
      const result = await this.model.findOneAndUpdate(
        { event_id: payload.event_id },
        { $setOnInsert: this.toDocument(payload) },
        { upsert: true, new: true, includeResultMetadata: true, setDefaultsOnInsert: true },
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
   * SDK 发的是扁平结构，这里把原始字段保留，同时补一份 exception 嵌套结构，
   * 让「原始契约」和「后续归一化要用的结构」并存。
   */
  private toDocument(payload: IngestPayload): Record<string, unknown> {
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
