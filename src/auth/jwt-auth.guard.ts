import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from './jwt.service';
import type { RequestWithUser } from './auth.types';

/**
 * 认证守卫（Authentication）——回答"你是谁"。
 *
 * 与 ProjectScopeGuard（Authorization，"你能看什么"）分开：
 * 前者是身份，后者是权限。混在一个守卫里，就会在"这个接口不需要项目上下文"
 * 的地方被迫写例外分支，那种分支是权限漏洞的老家。
 *
 * ── 为什么每次都回库查一次用户 ─────────────────────────────────────────
 * token 是自包含的，里面只有 userId。如果只信 token，那么"停用一个账号"
 * 要等 7 天它自然过期才生效 —— 这在真实事故里是不可接受的。
 * 这一次查询走的是 users 主键索引，亚毫秒级；用这点成本换"停用立刻生效"，值得。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const token = extractBearer(request.headers['authorization']);
    if (token === undefined) {
      throw new UnauthorizedException(
        '缺少访问令牌：请求头需要 Authorization: Bearer <token>。请先调用 POST /api/v1/auth/login',
      );
    }

    const result = this.jwt.verify(token);
    if (!result.ok) {
      // 具体原因（签名不匹配 / 已过期 / 算法不支持）对排查很有用，
      // 但完全不含密钥信息，所以可以放心回给客户端
      throw new UnauthorizedException(`访问令牌无效：${result.reason}`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: result.payload.sub },
      select: { id: true, email: true, displayName: true, isActive: true, orgId: true, role: true },
    });
    if (user === null) {
      throw new UnauthorizedException('访问令牌无效：账号不存在');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('账号已停用');
    }

    request.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      // orgId 与 role 一并带上：后续守卫和 service 就不用再查一次
      // （MVP-B 之后这里顺带拿到，比原来 join 成员表便宜）
      orgId: user.orgId,
      role: user.role,
    };
    return true;
  }
}

/**
 * 从 Authorization 头里取出 Bearer token。
 *
 * 只认 `Bearer <token>` 这一种写法（大小写不敏感）。
 * 不额外支持 `?token=`：JWT 出现在 URL 里会进访问日志、Referer、浏览器历史 ——
 * 而 JWT 就是登录凭据本身，泄露它等于泄露账号。
 * （上报公钥允许走 ?key=，是因为那不是账号凭据，且 sendBeacon 设不了请求头。）
 */
function extractBearer(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;

  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1].trim();
  return token === undefined || token === '' ? undefined : token;
}
