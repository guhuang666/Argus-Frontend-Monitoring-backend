import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ErrorEventDocument = HydratedDocument<ErrorEvent>;

/** 单个堆栈帧。SDK 目前只发 stack 原文，这个结构留给后端解析后写入 */
@Schema({ _id: false })
export class StackFrame {
  @Prop({ type: String, default: null })
  function!: string | null;

  @Prop({ type: String, required: true })
  filename!: string;

  @Prop({ type: Number, default: 0 })
  lineno!: number;

  @Prop({ type: Number, default: 0 })
  colno!: number;

  /** 是否为业务自身代码，由后端判定后回填 */
  @Prop({ type: Boolean, default: false })
  in_app!: boolean;
}
const StackFrameSchema = SchemaFactory.createForClass(StackFrame);

@Schema({ _id: false })
export class ExceptionValue {
  /** Error.name，如 TypeError */
  @Prop({ type: String, required: true })
  type!: string;

  /** 未归一化的原始 message */
  @Prop({ type: String, required: true })
  value!: string;

  @Prop({ type: String, required: true })
  mechanism!: string;

  @Prop({
    type: {
      raw: { type: String, default: '' },
      frames: { type: [StackFrameSchema], default: [] },
    },
    default: {},
  })
  stacktrace!: { raw: string; frames: StackFrame[] };
}
const ExceptionValueSchema = SchemaFactory.createForClass(ExceptionValue);

@Schema({ _id: false })
export class UserRef {
  @Prop({ type: String, required: true })
  id!: string;
}
const UserRefSchema = SchemaFactory.createForClass(UserRef);

@Schema({ _id: false })
export class SessionRef {
  @Prop({ type: String, required: true })
  id!: string;
}
const SessionRefSchema = SchemaFactory.createForClass(SessionRef);

/**
 * error_events —— 异常事件明细
 *
 * 字段对齐 SDK 的 CapturedError；payload 类字段（stack 原文）必须原样保留，
 * 归一化与指纹计算都发生在读取侧，不在这里做（SRS TC-10）。
 */
@Schema({
  collection: 'error_events',
  timestamps: { createdAt: 'created_at', updatedAt: false },
  versionKey: false,
})
export class ErrorEvent {
  @Prop({ type: String, required: true, unique: true })
  event_id!: string;

  /** 采集通道：onerror / unhandledrejection */
  @Prop({ type: String, required: true, enum: ['onerror', 'unhandledrejection'] })
  mechanism!: string;

  @Prop({ type: String, required: true })
  type!: string;

  @Prop({ type: String, required: true })
  message!: string;

  /** 整段 stack 原文 */
  @Prop({ type: String, default: '' })
  stack!: string;

  /** 出错位置 app.js:12:34；Promise 通道为空 */
  @Prop({ type: String })
  source?: string;

  /** 事件发生时间（客户端时钟） */
  @Prop({ type: Date, required: true })
  timestamp!: Date;

  /** 服务端接收时间，由 timestamps 自动写入 */
  created_at?: Date;

  @Prop({ type: String, required: true })
  url!: string;

  @Prop({ type: String, required: true })
  user_agent!: string;

  @Prop({ type: { name: String, version: String }, default: {} })
  sdk!: { name: string; version: string };

  @Prop({ type: ExceptionValueSchema, default: {} })
  exception!: ExceptionValue;

  @Prop({ type: UserRefSchema, default: null })
  user!: UserRef | null;

  @Prop({ type: SessionRefSchema, default: null })
  session!: SessionRef | null;

  @Prop({ type: String })
  release?: string;

  @Prop({ type: String })
  environment?: string;

  @Prop({ type: Object, default: {} })
  tags!: Record<string, string>;

  @Prop({ type: Object, default: {} })
  extra!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  breadcrumbs!: unknown[];
}

export const ErrorEventSchema = SchemaFactory.createForClass(ErrorEvent);

// 空字符串会污染查询结果，写入前归一成 undefined
ErrorEventSchema.pre('validate', function (next) {
  for (const key of ['source', 'release', 'environment'] as const) {
    if (this.get(key) === '') this.set(key, undefined);
  }
  next();
});

ErrorEventSchema.index({ event_id: 1 }, { unique: true });
ErrorEventSchema.index({ timestamp: -1 });
// 30 天保留（SRS FR-4.11）。TTL 由后台任务清理，不精确，误差约 0~60 秒
ErrorEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });
