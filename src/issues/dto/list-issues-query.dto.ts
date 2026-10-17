import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from '../../common/dto/page-query.dto';

/**
 * 问题的状态取值，与 schema.prisma 里 ErrorGroup.status 的注释一一对应。
 *
 * 用字符串联合而不是 TS enum：与 schema「status 用 varchar 而非 enum」
 * 的立场一致 —— 取值集合是产品语义，不是数据完整性约束。
 */
export const ISSUE_STATUSES = ['unresolved', 'resolved', 'ignored', 'archived'] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/**
 * 问题列表的查询参数：分页 + 可选按状态过滤。
 *
 * status 不传 = 不过滤，四种状态都返回。这与 GET /api/v1/error 的立场一致：
 * 默认不做任何过滤，避免"归并越成功、看板越空"这类自相矛盾。
 */
export class ListIssuesQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn([...ISSUE_STATUSES])
  status?: IssueStatus;
}
