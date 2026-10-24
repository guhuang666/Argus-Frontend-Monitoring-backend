import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { extractIngestKey } from '../common/ingest-key';
import { KeysService } from '../keys/keys.service';
import { MetricsService } from '../metrics/metrics.service';
import type { RequestWithIngest } from './ingest-context';
import { RateLimitService } from './rate-limit.service';

/** 窗口长度。与 RateLimitService 里的默认值一致，放这里是为了守卫自己能读 */
const WINDOW_MS = 1000;

/**
 * 上报限流守卫（M4-S6 / FR-6.1、6.3）。
 *
 * ── 为什么它是一个守卫，而不是写在控制器里 ──────────────────────────────
 * 上报接口是**公开**的（靠公钥鉴权，没人登录），所以它是全站唯一被
 * 无差别暴露的写入口。限流必须挂在这一层，且必须"漏挂就报错"。
 * 挂在 `@UseGuards()` 上，路由一眼就能看出有没有保护。
 *
 * ── 为什么解析公钥也搬到这里 ────────────────────────────────────────────
 * 限流要按项目计数，所以"哪个项目"必须先算出来。以前是控制器自己算，
 * 现在守卫算了之后挂到 request 上（`@IngestProject()`），控制器直接用 ——
 * 一次请求只解析一次，不多查库。
 *
 * ── 执行顺序 ────────────────────────────────────────────────────────────
 * 守卫跑在 ValidationPipe **之前**，所以格式不合法的请求也会消耗额度。
 * 这是有意的：攻击者正是用畸形请求来打的，不该让他们免费打。
 */
@Injectable()
export class IngestRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(IngestRateLimitGuard.name);

  constructor(
    private readonly keys: KeysService,
    private readonly limiter: RateLimitService,
    // 指标（M6-7）：被拒的那一条在 Prometheus 里也要能看见，
    // 否则"上报量掉了"和"被限流了"在监控上长得一模一样
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithIngest>();
    const response = context.switchToHttp().getResponse<Response>();

    // ① 公钥 → 项目（含限流配置）。解析失败直接 401，不再往下走
    const project = await this.keys.resolveProjectByPublicKey(extractIngestKey(request));
    request.ingest = project;

    // ② 开关：压测对照、本机演示、临时救急时能一键关掉
    //    默认开启 —— 一个"需要手动打开才生效"的限流，等于没有
    if (process.env.RATE_LIMIT_ENABLED === 'false') {
      return true;
    }

    // ③ 滑动窗口检查
    const verdict = await this.limiter.check(project.projectId, project.rateLimitPerSec, WINDOW_MS);

    // ④ 无论放行还是拒绝，都把额度写进响应头（FR-6.3）。
    //    客户端据此可以自己减速，而不是被 429 打个措手不及
    response.setHeader('X-RateLimit-Limit', String(project.rateLimitPerSec));
    if (verdict.remaining >= 0) {
      response.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
    }

    if (!verdict.allowed) {
      // Retry-After 的单位是**秒**（HTTP 规范），不足 1 秒也至少报 1
      const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      response.setHeader('Retry-After', String(retryAfterSec));

      // FR-6.4：这一条是被丢掉的，记一笔 —— 否则客户只能从"事件变少了"猜到
      // 自己被限流，而那种怀疑很容易被误判成"SDK 坏了"
      await this.limiter.recordDropped(project.projectId);
      // 同一件事在指标里也记一笔：Redis 的丢件计数是给**客户**看的，
      // 指标是给**运维**看的（能在 Grafana 上看到什么时候开始丢）
      this.metrics.recordRejected(project.projectId, 'rate_limit');

      // 只记日志，不把 projectId 拼进响应体 —— 响应可能被浏览器控制台截图外传
      this.logger.warn(
        `限流拒绝: project=${project.projectId} limit=${project.rateLimitPerSec}/s retryAfter=${retryAfterSec}s`,
      );

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message:
            `上报过于频繁：该项目的上限是 ${project.rateLimitPerSec} 次/秒。` +
            `请 ${retryAfterSec} 秒后重试（响应头 Retry-After）。`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
