import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

/**
 * 健康检查（M6-0）。
 *
 *   GET /api/v1/health/live    进程活着就 200 —— 挂了要重启进程
 *   GET /api/v1/health/ready   依赖全通才 200，任一不通 503 —— 挂了只是暂时不接流量
 *
 * ── 为什么这里没有 @UseGuards ────────────────────────────────────────────
 * 健康检查必须**匿名可访问**：K8s 的 kubelet、负载均衡、Prometheus 都不会带
 * 一个 7 天有效的 JWT。挂上鉴权等于让探针永远 401，编排系统会判定"不健康"
 * 然后无限重启 —— 一个为了保命的功能把服务搞死。
 *
 * 代价是这个接口对外开放。所以它的响应必须**只描述健康状态，不泄露任何配置**
 * （见 service 里的 redact()：连接串里的账号密码会被抹掉）。
 *
 * ── 为什么 /api/v1 前缀不省掉 ────────────────────────────────────────────
 * 有人会把探针路径配成 `/health`。但本项目的所有接口都在 `api/v1` 下，
 * 健康检查是给**这个服务**用的，跟业务接口共享同一条"版本化"约定：
 * 将来 v2 若调整探针语义，老路径还能留着给旧集群。
 */
@Controller('api/v1/health')
export class HealthController {
  constructor(private readonly service: HealthService) {}

  /** 存活探针。任何情况下都是 200 —— 能返回就说明进程活着 */
  @Get('live')
  live() {
    return this.service.checkLiveness();
  }

  /**
   * 就绪探针。状态码由检查结果决定，所以用 `passthrough: true`
   * （它只让我改状态码，返回体仍然走 Nest 的正常序列化，不用手写 res.json）。
   *
   * 不用 @HttpCode()：那个是静态的，而这里 200/503 是运行时算出来的。
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.service.checkReadiness();
    res.status(
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return result;
  }
}
