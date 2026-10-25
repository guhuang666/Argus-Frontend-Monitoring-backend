import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';

/**
 * 请求 id 的形状白名单。
 *
 * `x-request-id` 来自调用方（也就是不可信输入）。不校验的话，
 * 一个 `x-request-id: <script>` 或 10 KB 长的字符串会原样进日志，
 * 既污染结构化字段，也让"按 id 搜索"彻底失效。
 * 8~64 位、只允许字母数字和 `_-`，足以覆盖常见网关/框架生成的格式。
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 结构化日志 + 请求 id 贯穿（FR-10.1）。
 *
 * ── 为什么是 nestjs-pino 而不是裸 pino ──────────────────────────────────
 * 项目里已经有 20 多处 `new Logger(X.name)`。`app.useLogger(app.get(Logger))`
 * 会把 Nest 内置 Logger 的输出接到 pino 上 —— **业务代码一行都不用改**。
 * 手写方案要么把所有日志改成注入式，要么放弃结构化字段，两者都不划算。
 *
 * ── 这个模块被两个进程共用 ──────────────────────────────────────────────
 * API（main.ts）与 worker（worker.ts）都 import 它：
 *   · API 侧靠 pino-http 自动给每个请求生成 `req.id`，并记录访问日志
 *   · worker 侧没有 HTTP，但需要同一套 JSON 格式与同一个 redact 规则
 * 两边用同一个模块，格式才不会漂移。
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',

        /**
         * 请求 id：优先继承调用方传的（便于跨系统串联），否则自己生成。
         * 通过 `res.setHeader('x-request-id', ...)` 回传给客户端，
         * 用户报障时可以直接把他看到的那串贴给你。
         */
        genReqId: (req, res) => {
          const incoming = req.headers['x-request-id'];
          const id =
            typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
              ? incoming
              : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },

        /**
         * 敏感字段直接删除（remove: true），而不是替换成 "[Redacted]"。
         *
         * 打的都是真凭据，不是"看起来像凭据"：
         *   authorization     私钥 Bearer（sourcemap 上传）/ JWT
         *   x-argus-key       项目公钥（能往项目里灌数据）
         *   x-argus-secret    历史遗留的私钥头
         *   webhook_url       飞书机器人地址本身就是凭据
         *   password          登录接口的明文口令
         * 日志会被打包、截图、发给别人看 —— 这几个字段一个都不该出现在里面。
         *
         * x-request-id 也一起删，理由是另一条：它是**未校验的入参**。
         * 上面 genReqId 只让合法形状进 `req.id`，但 pino-http 的访问日志还会
         * 原样打印 `req.headers`，等于给了一条"随便塞任意字符串进日志"的旁路
         * （实测 `x-request-id: bad id!!` 会被原样记下来）。
         * 删掉它不会丢信息 —— 校验过的那个值永远是 `req.id` 字段。
         */
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-argus-key"]',
            'req.headers["x-argus-secret"]',
            'req.headers["x-request-id"]',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.webhook_url',
          ],
          remove: true,
        },

        /**
         * 访问日志的忽略规则。
         *
         * `/metrics` 默认 15 秒被抓一次 = 一天 5760 条纯噪音；
         * 健康检查同理。把它们排除，日志里剩下的才是"业务流量"。
         */
        autoLogging: {
          ignore: (req) => {
            const url = req.url ?? '';
            return url === '/metrics' || url.startsWith('/api/v1/health');
          },
        },

        /**
         * 开发期用 pino-pretty 让终端可读；生产必须是纯 JSON，
         * 否则日志采集器（Loki/ELK）解析不了。
         */
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  translateTime: 'SYS:HH:mm:ss.l',
                  ignore: 'pid,hostname',
                },
              },
      },
    }),
  ],
})
export class LoggingModule {}
