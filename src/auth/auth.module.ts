import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from './jwt.service';
import { ProjectAccessService } from './project-access.service';

/**
 * 鉴权模块（S4）。
 *
 * ── 为什么标 @Global ────────────────────────────────────────────────────
 * `JwtAuthGuard` 和 `ProjectScopeGuard` 会被 issues / performance /
 * error-events / projects 四个模块的控制器用 `@UseGuards()` 引用。
 * 守卫虽然写在 `@UseGuards` 里，但它仍然由 **Nest 的 DI 容器实例化** ——
 * 所以它的依赖（JwtService、ProjectAccessService）必须在那四个模块的
 * 注入器里可见。要么每个模块都 imports AuthModule，要么把它标成全局。
 *
 * 这里选全局，代价是模块边界变模糊一点；但反过来，任何一个新控制器
 * 只要写 `@UseGuards(JwtAuthGuard)` 就能立刻用上鉴权 —— 这个便利性
 * 对"防止漏加鉴权"更重要。
 *
 * 与 KeysModule 的立场一致：@Global 只用来放"横切每一个请求"的东西。
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [JwtService, AuthService, ProjectAccessService, JwtAuthGuard],
  exports: [JwtService, AuthService, ProjectAccessService, JwtAuthGuard],
})
export class AuthModule {}
