import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 新建项目（MVP-B / FR-5.8 的后端）。
 *
 * platform 只允许 browser：SRS 的范围里明确不做小程序 / RN / 原生崩溃，
 * 与其留一个"能填任何字符串但只有 browser 有意义"的自由文本，
 * 不如现在就把可选值钉死。将来加 node 的时候这里会变成真正的分支。
 */
export const PROJECT_PLATFORMS = ['browser'] as const;

export class CreateProjectDto {
  /**
   * 项目名。1~100 字符，与 projects.name 的 VarChar(100) 对齐 ——
   * DTO 不先拦的话，超长会在数据库层变成 500（P2000）而不是 400。
   */
  @IsString()
  @MinLength(1, { message: '项目名不能为空' })
  @MaxLength(100, { message: '项目名最长 100 字符' })
  name!: string;

  @IsOptional()
  @IsIn([...PROJECT_PLATFORMS], { message: `platform 只能是 ${PROJECT_PLATFORMS.join(' / ')}` })
  platform?: string;
}
