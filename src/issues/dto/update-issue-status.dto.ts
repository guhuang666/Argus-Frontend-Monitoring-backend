import { IsIn } from 'class-validator';
import { ISSUE_STATUSES, type IssueStatus } from './list-issues-query.dto';

/**
 * 修改问题状态（FR-4.8 状态机）。
 *
 * 只接受四个合法值。缺失或非法值会被全局 ValidationPipe 挡成 **400**，
 * 而不是悄悄写进库里 —— status 列是 varchar(20)，数据库本身拦不住乱值。
 *
 * 状态转移的合法性（比如"已归档能否直接改回未处理"）MVP 阶段不做限制：
 * 产品上这属于"人工纠正"，多绕一步反而不便。真正的自动流转只有一条
 * 在 worker 里：已解决的问题又收到新事件 → 回归为未处理。
 */
export class UpdateIssueStatusDto {
  @IsIn([...ISSUE_STATUSES])
  status!: IssueStatus;
}
