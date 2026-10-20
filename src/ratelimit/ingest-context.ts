import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * 上报入口的"我是哪个项目"。
 *
 * 由 IngestRateLimitGuard 填充：它在做限流之前必须先解析公钥，
 * 顺便把结果挂到请求上，控制器就不用再查一次库了。
 */
export interface IngestContext {
  projectId: string;
  /** 这个项目每秒允许的请求数（来自 projects.rate_limit_per_sec） */
  rateLimitPerSec: number;
}

export interface RequestWithIngest extends Request {
  ingest?: IngestContext;
}

/**
 * `@IngestProject()` —— 在控制器里取到已解析好的项目信息。
 *
 * 和 `@CurrentUser()` 一个思路：不用 `@Req()` 再手动 `req.ingest!.projectId`
 * （`!` 断言会把"守卫忘了挂"变成运行时的 undefined，而不是一个明确的错误）。
 */
export const IngestProject = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IngestContext => {
    const request = context.switchToHttp().getRequest<RequestWithIngest>();
    if (request.ingest === undefined) {
      // 走到这里说明路由漏了 @UseGuards(IngestRateLimitGuard)。
      // 抛出而不是返回 undefined：宁可直接 500，也不要拿空 projectId 去写库
      throw new Error('@IngestProject() 被使用了，但该路由没有 IngestRateLimitGuard');
    }
    return request.ingest;
  },
);
