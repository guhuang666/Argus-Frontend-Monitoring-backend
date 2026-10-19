import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import type { AuthUser } from './auth.types';

/**
 * 鉴权接口（FR-5.4）。
 *
 *   POST /api/v1/auth/register   注册（同时建组织 / 项目 / 密钥）
 *   POST /api/v1/auth/login      登录 → 拿 access_token
 *   POST /api/v1/auth/logout     登出
 *   GET  /api/v1/auth/me         当前用户 + 所属组织（看板刷新时用）
 *
 * ── 关于 logout 是个"空操作" ────────────────────────────────────────────
 * JWT 是无状态的：签发之后服务端没有它的记录，也没法"作废"它。
 * 所以真正的登出是**客户端删掉 token**，服务端这一端只能记一条日志。
 *
 * 想做"立即失效"有两条路，都没做，理由如下：
 *   · 服务端黑名单 —— 要存到 token 过期为止（7 天），为了登出功能引入一张
 *     会不断增长的Redis 表，收益低于成本
 *   · 更短的 token + refresh token —— 更正确的做法，但那是另一套完整机制
 *   现在把 token 有效期设成 7 天、登出由客户端负责，是明确的取舍，不是漏做。
 *
 * 接口仍然保留，因为：
 *   ① 前端需要一个"明确的登出动作"来触发清理
 *   ② 留一个将来能接黑名单/审计的位置
 */
@Controller('api/v1/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly service: AuthService) {}

  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.service.register(body);
  }

  /**
   * 登录。/login 用 200 而不是 201：**没有创建资源**，
   * 201 会让"登录成功"和"注册成功"在语义上混起来。
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: LoginDto) {
    return this.service.login(body);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() user: AuthUser): void {
    // 无状态 token 没有"服务端会话"可销毁，这里只留一条审计日志。
    // 客户端收到 204 后必须自己清掉 token —— 不清的话它依然有效
    this.logger.log(`用户登出（客户端需自行清除 token）: ${user.email}`);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.service.me(user.id);
  }
}
