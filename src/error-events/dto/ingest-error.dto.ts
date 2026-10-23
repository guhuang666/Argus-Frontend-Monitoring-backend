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

/**
 * 上报体里的用户标识。
 *
 * 只收 id —— 邮箱、手机号、姓名一律不进上报链路（PII 不该出现在监控系统里）。
 * 长度上限 100 必须与 error_events.user_id 的列宽一致：超了会撞 P2000 → 400
 * → **整条错误事件被丢掉**。为了一个用户 ID 丢掉一条错误是本末倒置。
 *
 * ⚠️ 这个值**不可信**：上报走公钥鉴权，而公钥本来就是公开的，任何人可以伪造。
 * 所以它只能用于统计（影响用户数 / UV），绝不能用于鉴权或计费。
 */
export class UserDto {
  @IsString()
  @Length(1, 100)
  id!: string;
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
   * 用户标识（M5）。SDK 三档降级的产物：账号 ID / 匿名设备 ID / 缺失。
   *
   * 必须在这里声明：ValidationPipe 的 whitelist 会把未声明的字段**静默剥掉**
   * ——不报错、数据凭空消失，比 400 更难查。
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => UserDto)
  user?: UserDto;

  /**
   * 会话标识（M5 / FR-1.23）。同一次访问内的所有事件共享同一个值。
   *
   * 长度上限 100 与 sessions.id 的列宽一致。**必须在这里声明**：
   * whitelist 会把未声明字段静默剥掉 —— 表现是"SDK 明明发了，
   * sessions 表却一行都没有"，而且不报任何错。
   */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  session_id?: string;

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
