import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IngestPerfDto } from './dto/ingest-perf.dto';
import { PerformanceMetric, PerformanceMetricDocument } from './performance-metric.schema';

export interface IngestPerfResult {
  event_id: string;
  /** true 表示这条事件之前已收到过（靠 event_id 唯一索引去重） */
  duplicate: boolean;
}

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    @InjectModel(PerformanceMetric.name)
    private readonly model: Model<PerformanceMetricDocument>,
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

  /** 写入一条性能指标。同一 event_id 重复上报不会产生第二条记录 */
  async ingest(payload: IngestPerfDto): Promise<IngestPerfResult> {
    this.logIncoming(payload);

    try {
      const result = await this.model.findOneAndUpdate(
        { event_id: payload.event_id },
        { $setOnInsert: this.toDocument(payload) },
        { upsert: true, returnDocument: 'after', includeResultMetadata: true, setDefaultsOnInsert: true },
      );

      const duplicate = result.lastErrorObject?.updatedExisting === true;
      if (duplicate) this.logger.debug(`性能事件已存在，跳过: ${payload.event_id}`);

      return { event_id: payload.event_id, duplicate };
    } catch (err) {
      // Schema 校验失败（缺 timestamp、url 等）属于客户端问题，返回 400 而不是 500
      if (err instanceof Error && err.name === 'ValidationError') {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * DTO → 入库文档。
   *
   * 和错误接口的区别：那边要额外补一份嵌套的 exception 结构（原始契约 + 后续归一化用的结构并存）；
   * 这里 DTO 和 schema 形状基本一致，只做三件必要的事：
   *   ① 把 null 显式落成 null，不要让它变成 undefined（Mongoose 会跳过 undefined，字段直接消失）
   *   ② 补默认值，保证每条记录形状完整
   *   ③ 时间字符串转 Date
   */
  private toDocument(payload: IngestPerfDto): Record<string, unknown> {
    const { metrics, attribution, device } = payload;
    return {
      event_id: payload.event_id,
      timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      url: payload.url ?? '',
      user_agent: payload.user_agent ?? '',
      sdk: payload.sdk ?? {},
      metrics: {
        // 用 ?? null 而不是 ?? 0：没测到就是没测到，别用 0 冒充
        lcp: metrics.lcp ?? null,
        cls: metrics.cls ?? null,
        inp: metrics.inp ?? null,
      },
      attribution: {
        lcp_element: attribution?.lcp_element ?? null,
        inp_target: attribution?.inp_target ?? null,
        inp_element: attribution?.inp_element ?? null,
        inp_phase: attribution?.inp_phase ?? null,
      },
      navigation_type: payload.navigation_type ?? null,
      device: {
        viewport: device?.viewport ?? '',
        dpr: device?.dpr ?? 0,
      },
      connection: payload.connection ?? null,
    };
  }
}
