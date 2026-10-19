import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser, RequestWithUser } from './auth.types';

/**
 * `@CurrentUser()` —— 在控制器里取到 JwtAuthGuard 放进来的用户。
 *
 * 为什么不用 `@Req() req` 然后 `req.user.id`：那样 `user` 的类型是 `any`，
 * 拼错一个字段名会在运行时变成 undefined，再变成一个查不到的项目、一个 404 ——
 * 排查时会一路怀疑到路由和数据上，而问题只是个拼写。
 * 装饰器给的是 `AuthUser`，拼错立刻编译不过。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (request.user === undefined) {
      // 走到这里说明装饰器和守卫的搭配错了（比如漏了 @UseGuards）。
      // 抛出而不是返回 undefined：宁可直接 500，也不要拿一个空用户去查数据
      throw new Error('@CurrentUser() 被使用了，但当前路由没有 JwtAuthGuard');
    }
    return request.user;
  },
);
