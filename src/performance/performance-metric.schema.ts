import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SessionRef, SessionRefSchema, UserRef, UserRefSchema } from '../error-events/error-event.schema';

export type PerformanceMetricDocument = HydratedDocument<PerformanceMetric>;

/**
 * 三个 Core Web Vitals。
 *
 * 每个字段都允许 null：**「没测到」和「测得 0」是两件事**。
 *   - LCP 0 表示没采到（观察器不支持 / 没有内容 / 跨域读不到值）
 *   - INP 0 或 null 表示"用户全程没交互过"，这跟"交互很快（0ms）"不是一回事
 * 用 0 兜底会让看板把"没数据"和"完美性能"混在一起，所以宁可存 null。
 */
@Schema({ _id: false })
export class PerfMetrics {
  /** Largest Contentful Paint，毫秒 */
  @Prop({ type: Number, default: null })
  lcp!: number | null;

  /** Cumulative Layout Shift，无单位小数。好的页面通常 < 0.1，所以不取整 */
  @Prop({ type: Number, default: null })
  cls!: number | null;

  /** Interaction to Next Paint，毫秒 */
  @Prop({ type: Number, default: null })
  inp!: number | null;
}
const PerfMetricsSchema = SchemaFactory.createForClass(PerfMetrics);

/**
 * 归因信息。光有数字没法优化，必须知道是谁拖慢的：
 *   lcp_element —— 哪张图/哪块内容（IMG / DIV / VIDEO…）
 *   inp_target  —— 哪类交互（pointerdown / keydown / click…）
 *   inp_element —— 点的哪个元素（光知道"点击慢"没法优化）
 *   inp_phase   —— 时间花在哪一段，决定开什么药方
 */
@Schema({ _id: false })
export class PerfAttribution {
  @Prop({ type: String, default: null })
  lcp_element!: string | null;

  @Prop({ type: String, default: null })
  inp_target!: string | null;

  @Prop({ type: String, default: null })
  inp_element!: string | null;

  /**
   * input-delay / processing / presentation，null 表示拿不到。
   * 不设 enum：Mongoose 的 enum 校验失败会让整条事件入库失败，而这是个辅助字段，
   * 为了它丢掉整条性能数据不值得。取值的合法性在 DTO 层已经卡过了。
   */
  @Prop({ type: String, default: null })
  inp_phase!: string | null;
}
const PerfAttributionSchema = SchemaFactory.createForClass(PerfAttribution);

/** 设备与网络上下文。性能分位数必须分维度看，混在一起没有指导意义 */
@Schema({ _id: false })
export class PerfDevice {
  /** 视口尺寸，形如 1440x900 */
  @Prop({ type: String, default: '' })
  viewport!: string;

  @Prop({ type: Number, default: 0 })
  dpr!: number;
}
const PerfDeviceSchema = SchemaFactory.createForClass(PerfDevice);

/**
 * performance_metrics —— 性能指标明细，一次页面加载一条。
 *
 * 和 error_events 的关键区别：**错误是稀疏的（出事才报），性能是全量的（每次 PV 都报）**。
 * 所以这张表的写入量级直接跟 PV 挂钩，采样（FR-1.15）是否开启会反映在 doc 数量上。
 *
 * 字段命名沿用 error_events 的约定（event_id / url / user_agent / sdk / release / environment），
 * 这样看板上「同一个页面、同一个 release」的错误率和性能可以按同一组维度关联。
 */
@Schema({
  collection: 'performance_metrics',
  timestamps: { createdAt: 'created_at', updatedAt: false },
  versionKey: false,
})
export class PerformanceMetric {
  @Prop({ type: String, required: true, unique: true })
  event_id!: string;

  /** 页面加载完成的时刻（客户端时钟） */
  @Prop({ type: Date, required: true })
  timestamp!: Date;

  /** 服务端接收时间，由 timestamps 自动写入 */
  created_at?: Date;

  /**
   * 计入指标的页面地址。
   *
   * 存完整 URL（含 query 和 hash），不做归一化：TC-10 的同一条纪律 ——
   * 归一化是「读取侧算排行」的动作，写入侧剥掉参数就没法再还原了。
   * SDK 侧只对面包屑做脱敏，事件自身字段原样上报。
   */
  @Prop({ type: String, required: true })
  url!: string;

  @Prop({ type: String, required: true })
  user_agent!: string;

  @Prop({ type: { name: String, version: String }, default: {} })
  sdk!: { name: string; version: string };

  @Prop({ type: PerfMetricsSchema, default: {} })
  metrics!: PerfMetrics;

  @Prop({ type: PerfAttributionSchema, default: {} })
  attribution!: PerfAttribution;

  /**
   * 导航类型：navigate / reload / back_forward。
   *
   * 必须存：用户刷新和从别的页返回时，LCP 天然比首次导航差。
   * 不看这个维度，看板上会出现大量"假警报" —— 明明只是刷新，却被当成性能劣化。
   */
  @Prop({ type: String, default: null })
  navigation_type!: string | null;

  @Prop({ type: PerfDeviceSchema, default: {} })
  device!: PerfDevice;

  /** 网络类型，只有 Chrome 系能拿到，其余为 null */
  @Prop({ type: String, default: null })
  connection!: string | null;

  @Prop({ type: UserRefSchema, default: null })
  user!: UserRef | null;

  @Prop({ type: SessionRefSchema, default: null })
  session!: SessionRef | null;

  @Prop({ type: String })
  release?: string;

  @Prop({ type: String })
  environment?: string;
}

export const PerformanceMetricSchema = SchemaFactory.createForClass(PerformanceMetric);

// 空字符串会污染查询结果，写入前归一成 undefined（与 error_events 一致）
PerformanceMetricSchema.pre('validate', async function () {
  for (const key of ['release', 'environment'] as const) {
    if (this.get(key) === '') this.set(key, undefined);
  }
});

// event_id 的唯一索引由 @Prop({ unique: true }) 声明，此处不可重复声明
// 看板 90% 的查询是「某页面某时间段的指标趋势」和「最近 N 条」，两者都吃这个索引
PerformanceMetricSchema.index({ url: 1, timestamp: -1 });
PerformanceMetricSchema.index({ timestamp: -1 });

// 明细保留 30 天（FR-4.11）。小时聚合表建好之前，过期即彻底丢失 —— 见 schema 注释里的待办
PerformanceMetricSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });
