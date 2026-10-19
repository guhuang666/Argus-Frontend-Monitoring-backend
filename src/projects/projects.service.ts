import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { generatePublicKey, generateSecretKey, hashSecret } from '../common/keys';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateProjectDto } from './dto/create-project.dto';

/**
 * 每个组织最多能建多少个项目（MVP-B 的防呆上限）。
 *
 * 为什么需要：`POST /projects` 每调一次就会生成一对密钥、写入两行。
 * 没有上限时，一个写成 `for (;;)` 的脚本能把项目表和密钥表刷满，
 * 而看板的项目切换器会被撑成几百项（它现在一次返回全部项目，没有分页）。
 * 20 对一个组织足够用，超了就是误操作或者滥用。
 */
const MAX_PROJECTS_PER_ORG = 20;

/** 允许创建项目的角色（FR-5.5）。member 只读 */
const CAN_CREATE_PROJECT_ROLES = new Set(['owner', 'admin']);

/**
 * 项目的读取与创建。
 *
 * ── 从 S2 到 MVP-B 的变化 ────────────────────────────────────────────────
 * `list(userId)` 曾经查的是「这个用户通过成员关系能看到的项目」（一次嵌套 join）。
 * 现在一个用户只属于一个组织，所以入参直接是 `orgId` —— 少一次 join，
 * 也少一个"join 写错就泄露"的机会。
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 项目列表（这个组织下的全部项目）。
   *
   * 只取"未吊销"的那把公钥：一个项目轮换过 key 之后会同时存在多行
   * project_keys，但 SDK 配置里该填的只有当前这一把。
   * 用 orderBy createdAt asc + 取第一条，保证同一项目每次返回同一把
   * （否则切换器里的 DSN 会随机跳动）。
   *
   * 过滤写在 where 里、而不是查完用 .filter() 筛：
   * 内存里筛意味着数据**已经读出来了**，一次手滑（比如把 filtered 用成 rows）
   * 就直接泄露。让不该读的行根本没离开数据库，才是隔离。
   */
  async list(orgId: string) {
    const rows = await this.prisma.project.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
      include: {
        keys: {
          where: { revokedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { publicKey: true },
        },
        _count: { select: { errorGroups: true, errorEvents: true } },
      },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        // Decimal → number：Prisma 的 Decimal 对象经 JSON.stringify 会变成
        // {"s":1,"e":0,"d":[1]} 这种形状，看板拿到没法直接用
        sample_rate: Number(row.sampleRate),
        rate_limit_per_sec: row.rateLimitPerSec,
        is_active: row.isActive,
        created_at: row.createdAt,
        public_key: row.keys[0]?.publicKey ?? null,
        issue_count: row._count.errorGroups,
        event_count: row._count.errorEvents,
      })),
    };
  }

  /**
   * 单个项目 + 全部有效公钥。
   *
   * 归属校验不在这里，而在 ProjectScopeGuard（见 projects.controller.ts 的 @UseGuards）。
   * 分工的理由：守卫负责"能不能进"，service 负责"进来之后取什么"。
   * 把权限判断散落在 service 里，就会出现"某个 service 方法忘了判"这种缺口；
   * 放在守卫上，控制器只要挂上就一定会经过。
   *
   * 代价是：**直接调用本方法（不经过路由）时没有越权保护**。
   * 目前只有控制器调它，所以可以接受；如果以后 worker 或脚本要复用，
   * 需要把 orgId 传进来自己再判一次。
   */
  async getById(id: string) {
    const row = await this.prisma.project.findUnique({
      where: { id },
      include: { keys: { where: { revokedAt: null }, orderBy: { createdAt: 'asc' } } },
    });
    if (row === null) {
      throw new NotFoundException(`项目不存在: ${id}`);
    }

    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      sample_rate: Number(row.sampleRate),
      rate_limit_per_sec: row.rateLimitPerSec,
      is_active: row.isActive,
      created_at: row.createdAt,
      // 详情里给出全部有效公钥（轮换期会有两把，前端可以标注哪把是新的）
      public_keys: row.keys.map((key) => ({
        public_key: key.publicKey,
        label: key.label,
        created_at: key.createdAt,
      })),
    };
  }

  /**
   * 新建项目 + 第一对密钥（FR-5.8 的后端）。
   *
   * ── 三件事在一个事务里 ──────────────────────────────────────────────────
   * 项目和密钥要么一起存在，要么都不存在。中间态（有项目没密钥）的表现是
   * "项目出现在切换器里，但上报全部 401，而且看不出为什么" —— 最难查的一种。
   *
   * ── 为什么私钥只返回一次 ────────────────────────────────────────────────
   * 库里只有 sha256。这是唯一能拿到明文的机会，前端必须当场让用户复制走。
   *
   * ── 为什么重名靠数据库约束 ──────────────────────────────────────────────
   * "先查有没有同名，再插入"在并发下两个请求会同时通过检查。
   * 真正的保证只能是 `@@unique([orgId, name])`，这里负责把 P2002 翻译成 409。
   */
  async create(orgId: string, role: string, dto: CreateProjectDto) {
    if (!CAN_CREATE_PROJECT_ROLES.has(role)) {
      // 403 而不是 404：用户确实属于这个组织，只是没这个权限。
      // 假装"不存在"只会让他困惑"我的组织怎么没了"
      throw new ForbiddenException('只有 owner / admin 能新建项目');
    }

    const name = dto.name.trim();
    if (name === '') {
      throw new BadRequestException('项目名不能为空');
    }

    const count = await this.prisma.project.count({ where: { orgId } });
    if (count >= MAX_PROJECTS_PER_ORG) {
      throw new BadRequestException(
        `每个组织最多 ${MAX_PROJECTS_PER_ORG} 个项目（当前 ${count} 个）`,
      );
    }

    const publicKey = generatePublicKey();
    const secretKey = generateSecretKey();

    try {
      const project = await this.prisma.project.create({
        data: {
          orgId,
          name,
          platform: dto.platform?.trim() || 'browser',
          keys: {
            create: [
              { publicKey, secretKeyHash: hashSecret(secretKey), label: 'initial' },
            ],
          },
        },
        select: { id: true, name: true, platform: true, createdAt: true },
      });

      return {
        project: {
          id: project.id,
          name: project.name,
          platform: project.platform,
          created_at: project.createdAt,
          public_key: publicKey,
        },
        /**
         * 明文私钥，**只在这里出现一次**。字段名带 `_once` 是提醒前端：
         * 这不是一个可以再查一次的东西。
         */
        secret_key_once: secretKey,
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`项目名已被使用: ${name}`);
      }
      throw err;
    }
  }
}
