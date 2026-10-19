import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 与后端各处 ParseUUIDPipe 的判据保持一致，避免"守卫放过、管道打回"的错位 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 项目级越权判断（FR-5.3 / FR-5.7）—— S4 的核心那一行。
 *
 * 问的是：**这个组织，能不能看这个项目？**
 * 判断依据只有一条：项目的 org_id 是否等于我的 org_id。
 *
 * ── 为什么押成一条 `id + orgId` 而不是"先查我的组织、再查项目" ──────────
 * 拆成两步就有个时间窗：两次查询之间组织归属可能变。而且拆开之后，
 * 第二段代码很容易被写成"只按 projectId 查"（漏掉组织条件）——
 * 这正是 TC-05 要防的那种失误。压成一条之后，"漏掉组织条件"在语法上就不成立了。
 *
 * ── 为什么是 404 而不是 403 ─────────────────────────────────────────────
 * FR-5.7 允许二选一。403 等于告诉对方"这个 id 确实存在，只是不归你"，
 * 那把 uuid 挨个试一遍就能数出别人有几个项目、几个问题。
 * 404 让"不存在"和"无权"变得不可区分。
 *
 * 注意"我是成员但没这个权限"（比如 member 想新建项目）走的是 **403**，
 * 因为那是同一个组织内部的事，说清楚才有用 —— 见 ProjectsService.create。
 */
@Injectable()
export class ProjectAccessService {
  private readonly logger = new Logger(ProjectAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 不通过就抛 404 */
  async assertAccess(orgId: string, projectId: string): Promise<void> {
    const row = await this.prisma.project.findFirst({
      // MVP-B 之后条件退化成"项目属于我的组织"这一条：
      // 不再需要 join 成员表，因为这个用户只可能属于一个组织
      where: { id: projectId, orgId },
      select: { id: true },
    });

    if (row === null) {
      // 日志里记下"谁试图看哪个项目"，试探行为因此会留下痕迹。
      // 但响应里不能体现 —— 那又变回 403 的效果了
      this.logger.warn(`越权或不存在: org=${orgId} project=${projectId}`);
      throw new NotFoundException(`项目不存在: ${projectId}`);
    }
  }
}

/**
 * 从请求里取出要访问的 projectId。
 *
 * 两个来源，顺序固定：
 *   query.projectId   读接口（/issues?projectId=...）
 *   params.projectId  带路径参数的接口（/projects/:projectId/...）
 *
 * 为什么在这里自己判 uuid，而不是等 ValidationPipe：**守卫跑在管道之前**。
 * 不先挡住的话，形状错误的 id 会一路传到 PG，变成 22P02 的 500。
 */
export function extractProjectId(source: {
  queryProjectId?: unknown;
  paramProjectId?: unknown;
}): string {
  for (const candidate of [source.queryProjectId, source.paramProjectId]) {
    // ?projectId=a&projectId=b 时 express 给的是数组，取第一个
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof value === 'string' && UUID_RE.test(value)) return value;
  }

  const received = source.queryProjectId ?? source.paramProjectId;
  // 这个错 90% 发生在手工调接口时，所以提示要能照着改
  throw new BadRequestException(
    `缺少或不合法的 projectId（需要 uuid）：收到 ${JSON.stringify(received)}。` +
      '以查询参数 ?projectId=<uuid> 或路径参数提供',
  );
}
