import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { TenantPageQueryDto } from '../../common/dto/tenant-query.dto';

/**
 * 告警历史列表的查询参数（M6-5）。
 *
 * ── 为什么 delivered 要单独写 @Transform ────────────────────────────────
 * query 参数永远是字符串：`?delivered=false` 到手是 `"false"`，而 `"false"`
 * 在布尔上下文里是**真值**。不转换的话 `@IsBoolean()` 直接 400，
 * 就算跳过了校验，`where: { delivered: "false" }` 也会把字符串塞给 Prisma。
 * 所以先把它转成真正的布尔，再校验。
 *
 * 只认 `"true"` / `"false"` 两个字符串：`?delivered=1` 这类写法一律当非法值，
 * 由 @IsBoolean 打回 400 —— 悄悄把 1 当 true 是另一种"我以为我筛过了"。
 *
 * ── 为什么 ruleId 是筛选条件而不是路径 ──────────────────────────────────
 * 「某个规则的触发记录」和「整个项目最近发生了什么」是同一种资源的不同切片，
 * 用同一个列表接口 + 条件就够了。ruleId 不存在时返回空列表，不 404 ——
 * 筛不到和"资源不存在"是两回事。
 */
export class ListAlertEventsQueryDto extends TenantPageQueryDto {
  @IsOptional()
  @IsUUID()
  ruleId?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  delivered?: boolean;

  /** 时间范围起点（含）。ISO 8601，作用于 fired_at */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** 时间范围终点（不含）。左闭右开，与项目里其它时间窗口一致 */
  @IsOptional()
  @IsISO8601()
  to?: string;
}
