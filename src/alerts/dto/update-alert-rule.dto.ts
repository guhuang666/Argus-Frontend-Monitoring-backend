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
 * 修改告警规则（PATCH，局部更新）。
 *
 * ── 为什么每个字段都是可选的 ────────────────────────────────────────────
 * PATCH 的语义是"只改我给了的字段"。界面上有两条完全不同的修改路径：
 *   · 开关一行 → 只发 `{ enabled: false }`
 *   · 编辑弹窗 → 发全部可编辑字段
 * 如果这里要求全量提交，开关那条路径就得先 GET 一次再回填整条规则，
 * 多一次请求，还多一个"别人刚改过、你提交的是旧值"的覆盖窗口。
 *
 * ── 为什么 webhook_url 不传就是"不改" ───────────────────────────────────
 * 读接口只返回末 6 位（脱敏），前端拿不到完整地址。如果"不传 = 清空"或者
 * "传什么都覆盖"，编辑弹窗只要没让用户重新输入，就会把真地址写坏。
 * 所以唯一安全的规则是：**没传这个键 = 保持原值**。
 */
export class UpdateAlertRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: '规则名不能为空' })
  @MaxLength(ALERT_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsIn([...ALERT_METRICS])
  metric?: AlertMetric;

  @IsOptional()
  @IsIn([...ALERT_COMPARATORS])
  comparator?: AlertComparator;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'threshold 必须是有限数字' })
  threshold?: number;

  @IsOptional()
  @IsInt()
  @Min(ALERT_WINDOW_MIN)
  @Max(ALERT_WINDOW_MAX)
  window_minutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  environment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  release?: string;

  @IsOptional()
  @IsIn([...ALERT_CHANNELS])
  channel?: AlertChannel;

  /** 不传 = 保持原地址；传了才覆盖 */
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true, require_tld: false },
    { message: 'webhook_url 必须是 http(s) 地址' },
  )
  @MaxLength(500)
  webhook_url?: string;

  @IsOptional()
  @IsInt()
  @Min(ALERT_SILENCE_MIN)
  @Max(ALERT_SILENCE_MAX)
  silence_minutes?: number;

  /** 开关。停用的规则不参与评估（M6-3），但历史与列表都保留 */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
