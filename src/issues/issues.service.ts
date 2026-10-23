import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ErrorEvent, Prisma } from '../../generated/prisma/client';
import type { PageQueryDto } from '../common/dto/page-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import type {
  IssueSort,
  ListIssuesQueryDto,
  SortOrder,
} from './dto/list-issues-query.dto';
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
   * 问题列表：六维筛选 + 排序 + 分页（FR-8.3）。
   *
   * 列表与总数放进同一个 $transaction —— 同一事务快照，并发写入时不会出现
   * "total=10 但翻到第 2 页是空的"这种自相矛盾（同 listErrorEvents 的立场）。
   * **两个查询必须用同一个 where**，否则 total 是"全部"、items 是"筛过的"，
   * 分页器会显示 3 页而第 2 页永远空。
   *
   * 默认排序仍是 lastSeen desc：索引 @@index([projectId, lastSeen(sort: Desc)])
   * 就是为它建的。换排序字段时也有对应的复合索引（timesSeen / usersSeen），
   * 否则会退化成对整个项目的问题行做一次全量 sort。
   */
  async listIssues(query: ListIssuesQueryDto) {
    const { page, pageSize, projectId, status, level, q, release, environment } =
      query;

    const lastSeen = buildTimeRange(query.from, query.to);

    // TC-08：projectId 永远在 where 里，且是第一个条件
    const where: Prisma.ErrorGroupWhereInput = {
      projectId,
      ...(status !== undefined ? { status } : {}),
      ...(level !== undefined ? { level } : {}),
      // 精确匹配"最近出现在哪个版本 / 环境"——语义见 schema 的列注释
      ...(release !== undefined ? { lastRelease: release } : {}),
      ...(environment !== undefined ? { lastEnvironment: environment } : {}),
      ...(lastSeen !== undefined ? { lastSeen } : {}),
      // 关键字：title 和 culprit 都要搜。culprit 是"疑似责任位置"，
      // 按函数名/文件名搜问题时它比 title 更常用（title 已经被归一化成占位符了）
      ...(q !== undefined
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' as const } },
              { culprit: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.errorGroup.findMany({
        where,
        // 第二排序键固定为 id：没有它时同分行的顺序由 PG 决定，
        // 翻页会出现"第 1 页和第 2 页都有同一行"（或都没有）
        orderBy: [buildOrderBy(query.sort, query.order), { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { events: true } } },
      }),
      this.prisma.errorGroup.count({ where }),
    ]);

    return { items: rows.map(toIssueRow), total, page, pageSize };
  }

  /**
   * 筛选栏的下拉数据（FR-8.3）：这个项目出现过哪些环境 / 版本。
   *
   * ── 为什么要有这个接口 ──────────────────────────────────────────────────
   * 让用户手输版本号是个陷阱：输错一个字符就筛出空列表，
   * 而"筛出空列表"和"这个版本真的没问题"在界面上长得一模一样。
   *
   * 取 `last_release` / `last_environment` 的去重值（不是 `error_events` 的）：
   * 筛选筛的就是问题行上的这两列，下拉的取值集合必须与它们同源，
   * 否则会出现"下拉里有 web@1.0.0，选中却一个问题都没有"。
   *
   * 上限 50：一个项目的版本可能很多，下拉框超过 50 个就已经没法用了，
   * 那时候该给的是一个可搜索的输入框，而不是把整张表拉下来。
   */
  async facets(projectId: string) {
    const [releases, environments] = await this.prisma.$transaction([
      this.prisma.errorGroup.findMany({
        where: { projectId, lastRelease: { not: null } },
        select: { lastRelease: true },
        distinct: ['lastRelease'],
        orderBy: { lastRelease: 'desc' },
        take: 50,
      }),
      this.prisma.errorGroup.findMany({
        where: { projectId, lastEnvironment: { not: null } },
        select: { lastEnvironment: true },
        distinct: ['lastEnvironment'],
        orderBy: { lastEnvironment: 'asc' },
        take: 50,
      }),
    ]);

    return {
      releases: releases
        .map((row) => row.lastRelease)
        .filter((value): value is string => value !== null),
      environments: environments
        .map((row) => row.lastEnvironment)
        .filter((value): value is string => value !== null),
    };
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
    // 环境与版本一起返回：筛选栏按这两列筛，列表里就得看得见它们的值，
    // 否则用户会疑惑"我筛了 production，凭什么是这几条"
    last_environment: row.lastEnvironment,
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

/**
 * from/to（ISO 字符串）→ Prisma 的 lastSeen 过滤条件。
 *
 * 左闭右开 `[from, to)`：闭区间会让相邻两个窗口都算上边界那一刻的事件，
 * 于是"上周"和"这周"加起来比"两周"多几条 —— 用户会以为数据重复了。
 *
 * 跨字段校验只能在这里做：class-validator 的装饰器是逐字段的，
 * 表达不了 "from 必须早于 to" 这种关系。DTO 里 @IsISO8601 保证能解析，
 * 这里保证区间本身有意义。
 */
function buildTimeRange(
  from: string | undefined,
  to: string | undefined,
): Prisma.DateTimeFilter | undefined {
  if (from === undefined && to === undefined) return undefined;

  const range: Prisma.DateTimeFilter = {};
  if (from !== undefined) range.gte = new Date(from);
  if (to !== undefined) range.lt = new Date(to);

  if (range.gte !== undefined && range.lt !== undefined && range.gte >= range.lt) {
    throw new BadRequestException('时间范围不合法：from 必须早于 to');
  }
  return range;
}

/**
 * 排序白名单 → Prisma 的 orderBy。
 *
 * 用 switch 而不是 `{ [SORT_FIELD[sort]]: order }` 这种计算属性：
 *   · 计算属性拿到的是 string 索引，Prisma 的 orderBy 类型检查会失效；
 *   · switch 让"新增一个排序字段"必须在三处同时改（DTO 白名单、这里、前端），
 *     漏改会直接编译不过，而不是运行时静默排序错乱。
 */
function buildOrderBy(
  sort: IssueSort,
  order: SortOrder,
): Prisma.ErrorGroupOrderByWithRelationInput {
  switch (sort) {
    case 'firstSeen':
      return { firstSeen: order };
    case 'timesSeen':
      return { timesSeen: order };
    case 'usersSeen':
      return { usersSeen: order };
    case 'lastSeen':
    default:
      return { lastSeen: order };
  }
}
