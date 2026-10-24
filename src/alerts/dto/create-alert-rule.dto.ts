import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ALERT_CHANNELS,
  ALERT_COMPARATORS,
  ALERT_METRICS,
  ALERT_NAME_MAX,
  ALERT_SILENCE_MAX,
  ALERT_SILENCE_MIN,
  ALERT_WINDOW_MAX,
  ALERT_WINDOW_MIN,
  type AlertChannel,
  type AlertComparator,
  type AlertMetric,
} from './alert-rule.constants';

/**
 * 新建告警规则（M6-2 / FR-7.1）。
 *
 * ── 为什么字段名是 snake_case ────────────────────────────────────────────
 * 与 `alert_rules` 的响应保持同一套命名（响应也是 snake_case，和面试/问题
 * 接口一致）。请求用 camelCase、响应用 snake_case 会让前端多一层映射，
 * 而且这种不一致最容易在"改一个字段名"时漏掉一半。
 *
 * ── 为什么环境/版本是可选的 ──────────────────────────────────────────────
 * FR-7.3 要求能按环境、版本圈定范围，但 M6-2 的界面先不暴露这两个字段
 * （表单已经 7 项，再加两项就超出这一批的预算）。接口先支持，
 * 等界面上加的时候不用改后端。
 */
export class CreateAlertRuleDto {
  /** 规则名，只给人看，不参与判定 */
  @IsString()
  @MinLength(1, { message: '规则名不能为空' })
  @MaxLength(ALERT_NAME_MAX, { message: `规则名最长 ${ALERT_NAME_MAX} 字符` })
  name!: string;

  @IsIn([...ALERT_METRICS], { message: `metric 只能是 ${ALERT_METRICS.join(' / ')}` })
  metric!: AlertMetric;

  @IsIn([...ALERT_COMPARATORS], { message: 'comparator 只能是 gt / lt' })
  comparator!: AlertComparator;

  /**
   * 阈值。Float 不是 Int：错误率是 0~1 的小数，LCP 是毫秒浮点。
   * 不限制正负：`lt` 规则配负数虽然奇怪，但那是用户的自由，不是数据错误。
   */
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'threshold 必须是有限数字' })
  threshold!: number;

  /**
   * 统计窗口（分钟），语义是 `[now - window, now)` 半开区间。
   * 必须显式传，不给默认值：窗口决定"多久算一次异常"，默认成 5 还是 60
   * 差别太大，猜错了会直接改变告警的灵敏度，宁可让调用方写清楚。
   */
  @IsInt()
  @Min(ALERT_WINDOW_MIN)
  @Max(ALERT_WINDOW_MAX)
  window_minutes!: number;

  /** 只看这个环境；不传 = 不限 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  environment?: string;

  /** 只看这个版本；不传 = 不限 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  release?: string;

  @IsIn([...ALERT_CHANNELS], { message: `channel 只能是 ${ALERT_CHANNELS.join(' / ')}` })
  channel!: AlertChannel;

  /**
   * Webhook 地址。**它是密钥**（能往群里发消息），但入库必须明文——
   * 投递器要拿它发请求，没法用哈希。所以纪律放在读接口上：
   * 响应只回末 6 位（见 alerts.service.ts 的 toRow）。
   *
   * `require_tld: false` 是为了允许 `http://127.0.0.1:9000/hook` 这类
   * 本地调试地址——告警联调时最常用的就是起个本地接收器。
   */
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true, require_tld: false },
    { message: 'webhook_url 必须是 http(s) 地址' },
  )
  @MaxLength(500)
  webhook_url!: string;

  /** 静默期（分钟）：触发后这么久内不再重复通知 */
  @IsOptional()
  @IsInt()
  @Min(ALERT_SILENCE_MIN)
  @Max(ALERT_SILENCE_MAX)
  silence_minutes: number = 30;

  /** 总开关。新建时默认启用 */
  @IsOptional()
  @IsBoolean()
  enabled: boolean = true;
}
