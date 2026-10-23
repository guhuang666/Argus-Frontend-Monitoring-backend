import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 一次"会话被使用"的记录。由两条上报链路（错误 / 性能）调用 */
export interface SessionTouch {
  /** 所属项目（TC-08：会话的一切操作都带 projectId） */
  projectId: string;
  /** 浏览器生成的会话 ID。null / 空串 = 这条事件没带会话，直接忽略 */
  sessionId: string | null | undefined;
  /** 会话归属的用户，可空（匿名会话） */
  userKey?: string | null;
  /** 事件发生时刻（客户端时钟）。缺省用服务端当前时间 */
  at?: Date;
  /** 这条事件是错误吗？错误率的分子靠它 */
  hasError?: boolean;
  /** 页面浏览增量。性能上报（每次页面加载一条）记 1 */
  pageViews?: number;
}

/** 与 sessions.id 的列宽一致 */
const SESSION_ID_MAX = 100;

/**
 * 会话写入（M5 / FR-1.23）。
 *
 * ── 为什么是一条裸 SQL 而不是 Prisma 的 upsert ───────────────────────────
 * 三个字段需要**原子**的特殊语义，Prisma 的 upsert 表达不了：
 *   · last_seen_at = GREATEST(旧值, 新值)  —— 乱序补报时"只前进不后退"
 *   · page_views   = 旧值 + 增量           —— 并发下累加不能读改写
 *   · had_error    = 旧值 OR 新值          —— 一旦为真永远为真
 * 写成"先查再改"会在这三处各留一个竞态。
 *
 * ── 为什么失败只 warn 不抛 ───────────────────────────────────────────────
 * 会话是**统计辅助数据**。它写失败最多让 PV/UV 少算一条，
 * 而把异常抛出去会让一条已经完整入库的错误事件被记成"上报失败"，
 * SDK 于是重试 —— 用一个统计问题换一个数据完整性问题，不划算。
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 记一次"这个会话被用到"。
   *
   * 幂等：同一个 sessionId 反复调用只会累加 page_views、拉长 last_seen_at，
   * 不会产生第二行 —— 主键 (project_id, id) 保证的。
   */
  async touch(input: SessionTouch): Promise<void> {
    const rawId = input.sessionId;
    if (rawId === null || rawId === undefined) return;
    const sessionId = rawId.trim();
    if (sessionId === '') return;

    const at = input.at ?? new Date();
    const pageViews = input.pageViews ?? 0;
    const hasError = input.hasError === true;
    const userKey = input.userKey ?? null;

    try {
      await this.prisma.$executeRaw`
        INSERT INTO sessions (id, project_id, user_key, started_at, last_seen_at, page_views, had_error)
        VALUES (
          ${sessionId.slice(0, SESSION_ID_MAX)},
          ${input.projectId}::uuid,
          ${userKey},
          ${at},
          ${at},
          ${pageViews},
          ${hasError}
        )
        ON CONFLICT (project_id, id) DO UPDATE
           SET last_seen_at = GREATEST(sessions.last_seen_at, EXCLUDED.last_seen_at),
               page_views   = sessions.page_views + EXCLUDED.page_views,
               had_error    = sessions.had_error OR EXCLUDED.had_error,
               -- 匿名会话后来登录了：用后来的身份补上，但不覆盖已有的非空值
               user_key     = COALESCE(sessions.user_key, EXCLUDED.user_key)
      `;
    } catch (err) {
      // 见类注释：这里是统计旁路，失败不能影响事件入库
      this.logger.warn(
        `会话写入失败（不影响事件入库）: project=${input.projectId} session=${sessionId} 原因=${String(err)}`,
      );
    }
  }
}
