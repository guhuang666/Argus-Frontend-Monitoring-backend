import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * SDK 上报的异常事件体（POST /api/v1/error）。
 *
 * 每个字段的上限都不是随手写的：这个接口对公网开放，请求体大小和字符串长度
 * 都必须有界，否则一条超长 stack 就能把内存和存储吃掉。
 */
export class SdkInfoDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsString()
  @MaxLength(32)
  version!: string;
}

export class IngestErrorDto {
  /** 事件唯一 ID，后端据此去重 */
  @IsString()
  @Length(1, 128)
  event_id!: string;

  /** 采集通道 */
  @IsIn(['onerror', 'unhandledrejection', 'resource'])
  mechanism!: 'onerror' | 'unhandledrejection' | 'resource';

  /** Error.name，如 TypeError */
  @IsString()
  @Length(1, 128)
  type!: string;

  /** 未归一化的原始 message */
  @IsString()
  @Length(1, 2000)
  message!: string;

  /** 整段 stack 原文。归一化与指纹在读取侧做，这里原样存 */
  @IsOptional()
  @IsString()
  // 上限按 SDK 裁剪前的单条 stack 留余量；1MB 整体裁剪由后续里程碑负责
  @MaxLength(64 * 1024)
  stack?: string;

  /** 出错位置；Promise 通道拿不到，SDK 会发空串 */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  source?: string;

  @IsOptional()
  @IsISO8601()
  timestamp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  user_agent?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SdkInfoDto)
  sdk?: SdkInfoDto;

  /**
   * 发布版本号，形如 web@1.2.4。M3 的 Sourcemap 按它匹配产物文件（FR-3.4）。
   *
   * 上限必须 ≤ 列宽（error_events.release 是 VARCHAR(100)）：放宽的话，
   * 客户端一条超长 release 会让整个 create 撞 P2000 → 400 → **这条错误事件永久丢失**。
   * 为了保住版本号而丢掉错误是本末倒置 —— 尺寸必须和 SDK 侧的截断、库里的列宽对齐。
   *
   * @IsOptional() 同时跳过 null 和 undefined：SDK 没配版本时整个字段不出现，
   * 这里放行，落库是 NULL（不是空串）。
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  release?: string;

  /** 运行环境，如 production / staging。列宽 50，上限理由同 release */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  environment?: string;

  /**
   * 错误发生前的行为轨迹（面包屑）。
   *
   * 这里只做"是个数组"的宽松校验，形状归 SDK 管：最小版每条形如
   * { timestamp, category: 'click', message }。
   *
   * 坑：DTO 不声明这个字段的话，ValidationPipe 的 whitelist 会**静默剥掉**它
   * ——不报错，数据凭空消失，比 400 更难查。
   */
  @IsOptional()
  @IsArray()
  breadcrumbs?: unknown[];
}
