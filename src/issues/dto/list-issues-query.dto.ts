import { IsIn, IsOptional } from 'class-validator';
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
 * 问题列表的查询参数：分页 + 租户 + 可选按状态过滤。
 *
 * status 不传 = 不过滤，四种状态都返回。这与 GET /api/v1/error 的立场一致：
 * 默认不做任何过滤，避免"归并越成功、看板越空"这类自相矛盾。
 *
 * projectId 继承自 TenantPageQueryDto（S2 起必填）：问题列表天然是"某个项目的"，
 * 没有"全部项目的问题"这种视图 —— 那会把两个项目的不同问题混成一张表，
 * 而它们的指纹空间本来就是独立的。
 */
export class ListIssuesQueryDto extends TenantPageQueryDto {
  @IsOptional()
  @IsIn([...ISSUE_STATUSES])
  status?: IssueStatus;
}
