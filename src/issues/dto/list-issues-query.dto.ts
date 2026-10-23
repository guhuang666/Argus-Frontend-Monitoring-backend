import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { TenantPageQueryDto } from '../../common/dto/tenant-query.dto';

/**
 * 问题的状态取值，与 schema.prisma 里 ErrorGroup.status 的注释一一对应。
 *
 * 用字符串联合而不是 TS enum：与 schema「status 用 varchar 而非 enum」
 * 的立场一致 —— 取值集合是产品语义，不是数据完整性约束。
 */
export const ISSUE_STATUSES = ['unresolved', 'resolved', 'ignored', 'archived'] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/**
 * 问题级别。
 *
 * ⚠ 当前 Worker 不推断级别，落库全是默认值 `error` —— 这一列**暂时恒等于 error**。
 * 筛选先做出来，等推断逻辑（按 stack / message 猜 fatal）补上就有数据可用。
 * 不因为"现在没数据"而不做：接口形状定下来之后，补数据不用改前端。
 */
export const ISSUE_LEVELS = ['fatal', 'error', 'warning', 'info'] as const;

export type IssueLevel = (typeof ISSUE_LEVELS)[number];

/**
 * 可排序字段白名单（FR-8.3）。
 *
 * 它会一路走到 Prisma 的 `orderBy`。虽然 Prisma 会参数化值，**标识符仍是拼进
 * SQL 的**，所以这个集合必须是代码里的常量：请求里的字符串最多匹配到其中一个 key，
 * 匹配不到就退化成默认排序，绝没有机会进语句。
 */
export const ISSUE_SORTS = ['lastSeen', 'firstSeen', 'timesSeen', 'usersSeen'] as const;

export type IssueSort = (typeof ISSUE_SORTS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;

export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * 问题列表的查询参数：分页 + 租户 + 六维筛选 + 排序（FR-8.3）。
 *
 * ── 每个维度回答的问题（互不重复，所以必须都能组合）────────────────────
 *   status       处理到哪一步了      未处理 / 已解决
 *   level        有多严重            fatal / error / warning
 *   environment  发生在哪            production / staging
 *   release      最近出现在哪一版    web@1.2.0
 *   from / to    什么时候出现过      作用于 last_seen
 *   q            具体是哪个错误      同时搜 title 和 culprit
 *
 * ── 为什么 from/to 用 ISO 字符串而不是 range 预设 ─────────────────────────
 * 预设（24h / 7d / 30d）是**界面**的选择，不是接口的契约：前端换算成具体时刻
 * 再发过来，接口就能表达"上周三到上周五"这种任意区间，不用为了新预设改后端。
 *
 * ── 默认值为什么是 sort=lastSeen / order=desc ───────────────────────────
 * 和改动前完全一致：不传任何新参数时，行为与旧接口逐字节相同。
 * 这是加过滤功能时唯一不会让现有调用方"悄悄变了行为"的做法。
 */
export class ListIssuesQueryDto extends TenantPageQueryDto {
  @IsOptional()
  @IsIn([...ISSUE_STATUSES])
  status?: IssueStatus;

  @IsOptional()
  @IsIn([...ISSUE_LEVELS])
  level?: IssueLevel;

  /**
   * 关键字。上限 100 字符：它会变成 `ILIKE '%q%'`，没有索引能帮上忙，
   * 不设上限等于允许任何人对整张表做一次超长匹配。
   */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;

  /** 精确匹配「最近出现在哪个版本」。长度与 last_release 列宽一致 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  release?: string;

  /** 精确匹配「最近出现在哪个环境」。长度与 last_environment 列宽一致 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  environment?: string;

  /** 时间范围起点（含）。ISO 8601，作用于 last_seen，服务端与前端都用 UTC */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** 时间范围终点（不含）。左闭右开：相邻两个窗口不会重复统计边界上的那条 */
  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn([...ISSUE_SORTS])
  sort: IssueSort = 'lastSeen';

  @IsOptional()
  @IsIn([...SORT_ORDERS])
  order: SortOrder = 'desc';
}
