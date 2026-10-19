import { IsUUID } from 'class-validator';
import { PageQueryDto } from './page-query.dto';

/**
 * 读接口的租户上下文（S2 起）。
 *
 * ── 为什么 projectId 是 query 参数，不是请求头 ────────────────────────────
 * 请求头（X-Argus-Project）更"干净"，但它让 URL 不再自解释：同一条链接换个头
 * 就看到别的项目的数据，贴到聊天里对不上号。而看板是要分享链接的。
 * S3 起来自路由 `/projects/:projectId/...`，S4 起以 JWT 里的身份为准、
 * 路由参数只做"校验它属于我"，这个字段则退化成可省略。
 *
 * ── 为什么必填、且用 @IsUUID 而不是 @IsString ────────────────────────────
 * TC-08 要求每个查询都显式带 projectId。必填 + 格式严格 = 忘传时是 400，
 * 而不是悄悄落到某个默认项目上去（那种 bug 在测试里永远不出现，只在生产里出现）。
 * 写错格式也在这里被拦下 —— 否则它会一路传到 PG，变成 22P02 的 500。
 */
export class TenantQueryDto {
  @IsUUID()
  projectId!: string;
}

/** 分页 + 租户。两者几乎总是同时出现，合成一个 DTO 免得每个控制器写两个 @Query() */
export class TenantPageQueryDto extends PageQueryDto {
  @IsUUID()
  projectId!: string;
}
