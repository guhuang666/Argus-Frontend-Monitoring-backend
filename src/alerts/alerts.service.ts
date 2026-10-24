import { Injectable, NotFoundException } from '@nestjs/common';
import type { AlertRule, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateAlertRuleDto } from './dto/create-alert-rule.dto';
import type { UpdateAlertRuleDto } from './dto/update-alert-rule.dto';

/** 脱敏时保留的尾部字符数。飞书/Slack 的 webhook 末尾是随机串，末 6 位不足以复原 */
const WEBHOOK_TAIL = 6;

/**
 * 告警规则的读写（M6-2）。
 *
 * ── 这个模块只做 CRUD ───────────────────────────────────────────────────
 * 评估（每分钟数一遍、超阈值就发）是 M6-3 的事，投递（真正调 webhook）是 M6-4。
 * 三件事拆开的原因：CRUD 是"配置"，评估是"定时计算"，投递是"外部调用" ——
 * 出错时的排查方向完全不同，混在一起会让"规则没生效"和"消息没发出去"
 * 看起来像同一个问题。
 *
 * ── 所有方法都显式收 projectId ─────────────────────────────────────────
 * TC-05：租户隔离落在数据访问层。这里不做"先查出来再判断归属"，
 * 而是把 projectId 直接写进 where —— 别人的规则根本不会被读出来，
 * 也就不存在"判断写漏了"这种失误。查不到统一 404（不区分"不存在"和"无权"）。
 */
@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 规则列表（不分页）。
   *
   * 不分页的理由同项目列表：一个项目上的规则数是十几个量级，
   * 分页只会让设置页多一个"第 2 页"的空导航。
   *
   * **不过滤 enabled**：停用的规则必须还在列表里，否则用户关掉开关之后
   * 就再也找不到它、也就没法重新打开。过滤是评估器的事，不是列表的事。
   */
  async list(projectId: string) {
    const rows = await this.prisma.alertRule.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    return { items: rows.map(toRow) };
  }

  async create(projectId: string, dto: CreateAlertRuleDto) {
    const row = await this.prisma.alertRule.create({
      data: {
        projectId,
        name: dto.name.trim(),
        metric: dto.metric,
        comparator: dto.comparator,
        threshold: dto.threshold,
        windowMinutes: dto.window_minutes,
        environment: dto.environment?.trim() || null,
        release: dto.release?.trim() || null,
        channel: dto.channel,
        webhookUrl: dto.webhook_url.trim(),
        silenceMinutes: dto.silence_minutes,
        enabled: dto.enabled,
      },
    });

    return toRow(row);
  }

  /**
   * 局部更新。
   *
   * 用 `updateMany({ where: { id, projectId } })` 而不是"先 findFirst 再 update"：
   * 后者在"查到之后、更新之前"有窗口——规则被删掉时 update 会抛 P2025，
   * 变成 500 而不是 404。updateMany 的 where 本身带 projectId，
   * 匹配不到就是 count=0，一条语句就完成了归属校验 + 更新。
   *
   * 代价是拿不到更新后的行（updateMany 只回 count），所以要再 findUnique 一次。
   * 两次查询都在同一个项目的范围内，不存在跨租户读。
   */
  async update(projectId: string, id: string, dto: UpdateAlertRuleDto) {
    const data = toUpdateData(dto);

    // PATCH 里一个字段都没给：不是错误，是"什么都不改"，直接把当前状态还回去
    if (Object.keys(data).length === 0) {
      const current = await this.prisma.alertRule.findFirst({ where: { id, projectId } });
      if (current === null) {
        throw notFound(id);
      }
      return toRow(current);
    }

    const { count } = await this.prisma.alertRule.updateMany({
      where: { id, projectId },
      data,
    });
    if (count === 0) {
      throw notFound(id);
    }

    const row = await this.prisma.alertRule.findUniqueOrThrow({ where: { id } });
    return toRow(row);
  }

  /**
   * 删除规则。
   *
   * `deleteMany` 而不是 `delete`：同样是为了一次语句里带上 projectId。
   * 外键是 Cascade，删规则会连带删掉它的触发历史（alert_events）——
   * 这是 schema 里刻意定的：规则都没了，残留的历史没有归属，只会让
   * "最近告警"列表里出现点不进去的空条目。
   */
  async remove(projectId: string, id: string): Promise<void> {
    const { count } = await this.prisma.alertRule.deleteMany({ where: { id, projectId } });
    if (count === 0) {
      throw notFound(id);
    }
  }
}

/**
 * 一行 `alert_rules` → 接口响应。
 *
 * ── webhook_url 的处理是这里唯一有安全含义的地方 ────────────────────────
 * 完整地址**永远不出现在响应里**：它能往群里发消息，等于凭证。
 * 只回 `***` + 末 6 位，让人能确认"是不是这条"，但不足以拿去调用。
 * 同时给一个 `webhook_url_set` 布尔：前端要区分"有地址"和"没配地址"，
 * 光看 `***` 是分不出来的。
 *
 * 其余字段一律显式列举，不 return row：以后表里加内部列（比如评估用的
 * 游标字段），不会自动漏进接口。
 */
function toRow(row: AlertRule) {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold,
    window_minutes: row.windowMinutes,
    environment: row.environment,
    release: row.release,
    channel: row.channel,
    webhook_url_masked: maskWebhook(row.webhookUrl),
    webhook_url_set: row.webhookUrl.length > 0,
    silence_minutes: row.silenceMinutes,
    enabled: row.enabled,
    last_fired_at: row.lastFiredAt,
    created_at: row.createdAt,
  };
}

/** `https://open.feishu.cn/.../abc123` → `***abc123` */
function maskWebhook(url: string): string {
  return `***${url.slice(-WEBHOOK_TAIL)}`;
}

/**
 * PATCH 的 DTO → Prisma 的 update 载荷。
 *
 * 只把**调用方显式给了的键**放进去：`undefined` 在 Prisma 里的语义就是
 * "不更新这一列"，正好是 PATCH 要的。所以这里不能用 `?? null` 统一兜底，
 * 那会把"没传"变成"清空"。
 */
function toUpdateData(dto: UpdateAlertRuleDto): Prisma.AlertRuleUpdateManyMutationInput {
  const data: Prisma.AlertRuleUpdateManyMutationInput = {};

  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.metric !== undefined) data.metric = dto.metric;
  if (dto.comparator !== undefined) data.comparator = dto.comparator;
  if (dto.threshold !== undefined) data.threshold = dto.threshold;
  if (dto.window_minutes !== undefined) data.windowMinutes = dto.window_minutes;
  if (dto.environment !== undefined) data.environment = dto.environment.trim() || null;
  if (dto.release !== undefined) data.release = dto.release.trim() || null;
  if (dto.channel !== undefined) data.channel = dto.channel;
  // 只有真的传了地址才覆盖；没传 = 保持原值（读接口只回脱敏值，前端没法回填）
  if (dto.webhook_url !== undefined) data.webhookUrl = dto.webhook_url.trim();
  if (dto.silence_minutes !== undefined) data.silenceMinutes = dto.silence_minutes;
  if (dto.enabled !== undefined) data.enabled = dto.enabled;

  return data;
}

/** 统一的 404：不区分"不存在"和"属于别的项目"，避免被用来枚举 id */
function notFound(id: string): NotFoundException {
  return new NotFoundException(`告警规则不存在: ${id}`);
}
