/**
 * e2e 的环境准备。由 jest 的 `setupFiles` 在**测试文件加载之前**执行。
 *
 * ── 为什么必须在这里改 env，而不是在 spec 里写 ──────────────────────────
 * `ConfigModule.forRoot()` 在模块实例化时才读 .env；而 dotenv 的规则是
 * **不覆盖已存在的 process.env**。所以：
 *   · 测试跑 `?schema=e2e`，开发库一行数据都不会被动到
 *   · 但签名、库地址这些值必须在 AppModule 被 import 之前就位
 * `setupFiles` 正是"早于一切测试文件"的那个时机。
 *
 * 想临时指向别的库（比如 CI 的 service container）就设 E2E_DATABASE_URL。
 */
const DEFAULT_E2E_DATABASE_URL =
  'postgresql://argus:argus@127.0.0.1:5432/argus?schema=e2e';

process.env.DATABASE_URL = process.env.E2E_DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL;

/**
 * 关掉限流：上报接口默认 100 次/秒，e2e 里连发几个用例就可能撞 429，
 * 变成"随机失败"。想专门测限流的那条用例自己把开关打开即可。
 */
process.env.RATE_LIMIT_ENABLED = 'false';

/** pino 每个请求打一行 JSON，测试输出会被淹没；要排查时临时改回 info */
process.env.LOG_LEVEL = 'silent';

/** 鉴权模块 fail-closed：没有密钥直接起不来。测试给一个假值即可 */
process.env.JWT_SECRET ??= 'e2e-only-secret-not-used-outside-tests';

/** .map 落盘目录与开发环境分开，避免测试产物混进 backend/uploads */
process.env.UPLOADS_DIR ??= 'uploads-e2e';
