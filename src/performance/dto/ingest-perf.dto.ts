import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * SDK 上报的性能指标体（POST /api/v1/performance）。
 *
 * 和错误接口一样，每个字段都要有上界：这个接口对公网开放，
 * 不限长度的话一条超长 url 就能把存储吃掉。
 */
export class PerfSdkInfoDto {
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
 * 长度上限 100 必须与 performance_metrics.user_id 的列宽一致：超了会撞 P2000 → 400
 * → **整条性能事件被丢掉**。为了一个用户 ID 丢掉一条指标是本末倒置。
 *
 * 与错误通道的 UserDto 形状完全相同（SDK 两个通道共用同一个 resolveUser()），
 * 但**刻意各留一份而不共享**：两个 DTO 是两条独立的公开契约，将来一条要加字段
 * 时不该牵动另一条。
 *
 * ⚠️ 这个值**不可信**：上报走公钥鉴权，而公钥本来就是公开的，任何人可以伪造。
 * 所以它只能用于统计（影响用户数 / UV），绝不能用于鉴权或计费。
 */
export class PerfUserDto {
  @IsString()
  @Length(1, 100)
  id!: string;
}

/**
 * 指标值。
 *
 * ⚠️ 这里的 `@IsOptional()` 不是可有可无的装饰：SDK 在「没采到」时发的是 **null**，
 * 而 class-validator 的 @IsOptional() 会跳过 null 和 undefined 两种值。
 * 少了它，null 会被当成非法数字而被 ValidationPipe 剥掉 ——
 * 于是「用户没交互过所以没有 INP」这条信息静默丢失，看板上分不出
 * 「没数据」和「性能完美」。这是 DTO 层最容易踩的坑。
 */
export class PerfMetricsDto {
  /** Largest Contentful Paint，毫秒。上界 5 分钟：比这更长说明是数据异常，不是真实指标 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(300000)
  lcp?: number | null;

  /** Cumulative Layout Shift，无单位小数。允许超过 1 —— 单次大幅偏移就可能 > 1 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  cls?: number | null;

  /** Interaction to Next Paint，毫秒。上界 1 小时，理由同 lcp */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(3600000)
  inp?: number | null;
}

/**
 * 归因：数字本身不能行动，得知道是哪个元素 / 哪类交互 / 时间花在哪一段。
 */
export class PerfAttributionDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  lcp_element?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  inp_target?: string | null;

  /** 触发 INP 的元素标签名。光知道"点击慢"没法优化，得知道点的哪个元素 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  inp_element?: string | null;

  /**
   * INP 的时间主要花在哪一段。用 @IsIn 卡住取值：
   * 这个字段决定看板怎么开药方，写错一个值就会被归到错误的优化建议里。
   */
  @IsOptional()
  @IsIn(['input-delay', 'processing', 'presentation'])
  inp_phase?: 'input-delay' | 'processing' | 'presentation' | null;
}

/**
 * 设备与网络上下文。
 *
 * 不分这些维度算出来的 P75 是"所有设备混在一起"的平均值，没有指导意义 ——
 * 手机 4G 和桌面光纤的 LCP 差好几倍，混在一起两个问题都看不出来。
 */
export class PerfDeviceDto {
  /** 视口尺寸，形如 1440x900 */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  viewport?: string;

  /** 设备像素比 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  dpr?: number;
}

export class IngestPerfDto {
  /** 事件唯一 ID，后端据此去重（keepalive 重复投递时同一事件会到两次） */
  @IsString()
  @Length(1, 128)
  event_id!: string;

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
  @Type(() => PerfSdkInfoDto)
  sdk?: PerfSdkInfoDto;

  /**
   * 三个指标。
   *
   * `@IsDefined()` 不能省：`@ValidateNested()` 只校验"如果字段存在，形状对不对"，
   * 字段整个缺失时它**直接跳过**，请求照样 200 —— 于是库里多出一条没有任何指标的空记录。
   * 一个性能事件连一个指标都没有，说明 SDK 那边出了 bug，应该拒掉。
   * （SDK 侧也有对应的"三项全空就不发"判断，这里是在服务端再兜一道。）
   */
  @IsDefined()
  @ValidateNested()
  @Type(() => PerfMetricsDto)
  metrics!: PerfMetricsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PerfAttributionDto)
  attribution?: PerfAttributionDto;

  /**
   * 导航类型（navigate / reload / back_forward）。
   *
   * 不做 @IsIn 白名单：NavigationType 将来可能新增取值（规范演进），
   * 卡死会导致新值让整条事件被拒 —— 丢数据比多存一个值更糟。
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  navigation_type?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PerfDeviceDto)
  device?: PerfDeviceDto;

  /**
   * 网络类型（Network Information API 的 effectiveType），如 4g / 3g / slow-2g。
   * 只有 Chrome 系支持，Safari / Firefox 一律为 null。
   */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  connection?: string | null;

  /**
   * 用户标识。SDK 的性能通道从 `resolveUser()` 取，与错误通道同源同形。
   *
   * ── 为什么现在才收 ────────────────────────────────────────────────────
   * `performance_metrics.user_id` 这一列早就在（Mongoose 时代就有），但一直没有
   * 上行链路，恒为 NULL —— 表现是「哪个用户的 LCP 最差」答不出来。
   * SDK 侧的 PerfEvent 从 M3 起就已经带 `user: { id }` 了，缺的只是接收端。
   *
   * 可空：SDK 拿不到身份时发 null，按"匿名访问"处理 —— 匿名不影响指标本身，
   * 只是不参与用户维度统计，所以不该因为缺身份就把整条指标拒掉。
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PerfUserDto)
  user?: PerfUserDto | null;
}
