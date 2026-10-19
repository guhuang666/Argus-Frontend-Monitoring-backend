import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ErrorEvent, Prisma } from '../../generated/prisma/client';
import type { PageQueryDto } from '../common/dto/page-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { ListIssuesQueryDto } from './dto/list-issues-query.dto';
import type { UpdateIssueStatusDto } from './dto/update-issue-status.dto';

/** error_groups 行 + 事件总数（列表和详情都要显示"这个问题发生了 N 次"） */
type GroupWithCount = Prisma.ErrorGroupGetPayload<{
  include: { _count: { select: { events: true } } };
}>;

/**
 * 问题（归并后的实体）的读写。
 *
 * 数据来源就是 worker 归并产出的 `error_groups` —— 这里不重新算指纹，
 * 只负责把结果读出来、以及把状态改掉。指纹的算法与版本在 grouping/ 里，
 * 两边不互相 import（worker 进程不需要本模块，API 进程不需要归并）。
 */
@Injectable()
export class IssuesService {
  private readonly logger = new Logger(IssuesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 问题列表：按最近出现时间倒序，分页。
   *
   * 列表与总数放进同一个 $transaction —— 同一事务快照，并发写入时不会出现
   * "total=10 但翻到第 2 页是空的"这种自相矛盾（同 listErrorEvents 的立场）。
   *
   * 排序用 lastSeen 而不是 firstSeen：索引 @@index([lastSeen(sort: Desc)])
   * 就是为它建的，换字段就是全表 sort。
   */
  async listIssues(query: ListIssuesQueryDto) {
    const { page, pageSize, status, projectId } = query;
    // TC-08：projectId 永远在 where 里（M4-S2 起来自查询参数，S4 起由 JWT 决定）
    const where = status === undefined ? { projectId } : { projectId, status };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.errorGroup.findMany({
        where,
        orderBy: { lastSeen: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { events: true } } },
      }),
      this.prisma.errorGroup.count({ where }),
    ]);

    return { items: rows.map(toIssueRow), total, page, pageSize };
  }

  /**
   * 问题详情：问题本身 + 它下面的事件（分页，按事件时间倒序）。
   *
   * 事件用分页而不是全量：一个热门问题可能有几十万条明细，
   * 详情页首屏只需要最新的一页（FR-8.9「原始事件列表」同此口径）。
   */
  async getIssue(id: string, projectId: string, query: PageQueryDto) {
    const { page, pageSize } = query;

    // 用 findFirst 而不是 findUnique：要按 (id, projectId) 双重定位，
    // 别人的项目 id 在这里查不到 → 走"问题不存在"，不泄露"存在但无权"
    const group = await this.prisma.errorGroup.findFirst({
      where: { id, projectId },
      include: { _count: { select: { events: true } } },
    });
    if (group === null) {
      throw new NotFoundException(`问题不存在: ${id}`);
    }

    const where = { groupId: id, projectId };
    const [events, total] = await this.prisma.$transaction([
      this.prisma.errorEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.errorEvent.count({ where }),
    ]);

    return {
      issue: toIssueRow(group),
      events: { items: events.map(toDetailEventRow), total, page, pageSize },
    };
  }

  /**
   * 改问题状态（FR-4.8）。
   *
   * resolved_at 只在进入 resolved 时打点、离开时清空 —— 与 schema 注释
   * 「NULL 表示尚未解决」的语义一致。所以不能无脑每次 update：
   * 对同一个状态重复调用是幂等的，不会反复刷新时间。
   */
  async updateStatus(id: string, projectId: string, dto: UpdateIssueStatusDto) {
    // 同 getIssue：先按 (id, projectId) 确认归属，再更新
    const group = await this.prisma.errorGroup.findFirst({
      where: { id, projectId },
      include: { _count: { select: { events: true } } },
    });
    if (group === null) {
      throw new NotFoundException(`问题不存在: ${id}`);
    }

    if (group.status === dto.status) {
      // 幂等：状态没变就不写库，免得把 resolved_at 刷新掉
      return { issue: toIssueRow(group), changed: false };
    }

    const updated = await this.prisma.errorGroup.update({
      where: { id },
      data: {
        status: dto.status,
        resolvedAt: dto.status === 'resolved' ? new Date() : null,
      },
      include: { _count: { select: { events: true } } },
    });

    this.logger.log(`问题状态变更: id=${id} ${group.status} -> ${dto.status}`);
    return { issue: toIssueRow(updated), changed: true };
  }
}

/**
 * error_groups 行 → 接口响应。
 *
 * 三条约定，每条都有具体原因：
 *   ① 字段一律 snake_case，与 ingest 响应、GET /error 的既有契约一致
 *   ② **BigInt 必须显式转 number** —— JSON.stringify 遇到 BigInt 会直接抛
 *      TypeError（`Do not know how to serialize a BigInt`）。error_groups 的
 *      times_seen / users_seen 是 BIGINT，这是本模块与 error_events 最大的不同
 *      （error_events 没有 BigInt 列，所以 toApiRow 不需要处理）。计数不可能
 *      超过 2^53，用 Number 不会丢精度
 *   ③ 显式列字段而不是 return row：以后给表加内部列，不会自动漏进响应
 */
function toIssueRow(row: GroupWithCount) {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    grouping_version: row.groupingVersion,
    title: row.title,
    culprit: row.culprit,
    level: row.level,
    status: row.status,
    times_seen: Number(row.timesSeen),
    users_seen: Number(row.usersSeen),
    first_seen: row.firstSeen,
    last_seen: row.lastSeen,
    first_release: row.firstRelease,
    last_release: row.lastRelease,
    resolved_at: row.resolvedAt,
    /** 实际挂在下面的明细条数，与 times_seen 应当相等（可用于自查归并是否准确） */
    event_count: row._count.events,
  };
}

/**
 * 详情页里的事件视图。
 *
 * 只给"看懂这次发生了什么事"需要的字段，不做全字段镜像 —— 全量行仍可通过
 * GET /api/v1/error 拿到。stack 给原文而不是只给解析后的 frames：M3 之前
 * 没有符号化，frames 里的位置指向压缩产物，排查时人还是得看原文。
 */
function toDetailEventRow(row: ErrorEvent) {
  return {
    event_id: row.eventId,
    mechanism: row.mechanism,
    type: row.type,
    message: row.message,
    timestamp: row.timestamp,
    received_at: row.receivedAt,
    url: row.url,
    user_agent: row.userAgent,
    source: row.source,
    stack: row.stack,
    stacktrace_frames: row.stacktraceFrames,
    breadcrumbs: row.breadcrumbs,
    release: row.release,
    environment: row.environment,
  };
}
