import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ProjectAccessService, extractProjectId } from './project-access.service';
import type { RequestWithUser } from './auth.types';

/**
 * 项目作用域守卫（Authorization）——回答"你能看这个项目吗"。
 *
 * 必须挂在 JwtAuthGuard **之后**：它依赖前者塞进 request 的 user。
 * `@UseGuards(JwtAuthGuard, ProjectScopeGuard)` 的顺序就是执行顺序，
 * 写反了会拿到 `request.user === undefined`，然后 401（而不是越权放行）——
 * 失败方向是安全的，但错误信息会让人以为"没登录"，所以顺序别写反。
 *
 * ── 为什么用一个守卫统一处理，而不是每个控制器里手写一遍 ────────────────
 * 手写的话，漏写一处就是一处越权洞，而漏写是**不会报错**的：
 * 接口照样返回数据，只是返回了别人的。TC-05 要求隔离在数据访问层强制，
 * 守卫就是"访问层"的入口。
 */
@Injectable()
export class ProjectScopeGuard implements CanActivate {
  constructor(private readonly access: ProjectAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const user = request.user;
    if (user === undefined) {
      throw new UnauthorizedException('未认证：ProjectScopeGuard 必须与 JwtAuthGuard 一起使用');
    }

    const projectId = extractProjectId({
      queryProjectId: request.query?.['projectId'],
      paramProjectId: request.params?.['projectId'],
    });

    await this.access.assertAccess(user.orgId, projectId);
    return true;
  }
}
