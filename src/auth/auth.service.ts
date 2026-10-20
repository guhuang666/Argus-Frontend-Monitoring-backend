import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password';
import { JwtService } from './jwt.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 注册：一个人 + 一个组织。**不建项目、不发密钥**。
   *
   * ── 为什么注册不再顺手建一个"默认项目" ──────────────────────────────────
   * 那会让两件事绑死：用户还没想好要监控什么，系统就先替他建了一个叫
   * 「默认项目」的东西，还发了一对被他自己都记不住的密钥。结果是：
   *   · 第一个项目永远是名字没意义的"默认项目"
   *   · 密钥在注册那一屏一闪而过，很多人根本没抄下来
   *   · 想改项目名？没这个功能。只能删了重来（也没这个功能）
   * 拆开之后路径很清楚：注册 → 看板提示"还没有项目" → 点「新建项目」→
   * 在弹窗里填自己的名字 → 拿到一对属于它的密钥。私钥仍然只显示一次，
   * 但那一次是用户主动触发的，他知道自己在看什么。
   *
   * ── 为什么组织仍然在注册时建 ────────────────────────────────────────────
   * `users.org_id` 是 NOT NULL：没有组织，这个账号就无家可归，也什么都管不了。
   * 所以"注册即建组织"是数据模型的约束，不是偷懒。
   * （真要拆，得先做一个"创建/加入工作区"的引导页，那是另一件事。）
   *
   * ── 为什么还要事务 ──────────────────────────────────────────────────────
   * 只剩两步，但顺序有意义：组织先建（拿到 id），用户才能带上 org_id。
   * 中间失败留下一个没人属于的空组织，会占着 slug 再也删不掉。
   */
  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await hashPassword(dto.password);
    // 空串一律当"没填"：留一个空白的 displayName 会让界面上出现一行空白的欢迎语
    const displayName = dto.display_name?.trim() || null;
    const orgName = dto.organization_name?.trim() || `${email.split('@')[0]} 的工作区`;

    let created;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          // slug 必须唯一。用随机后缀而不是纯邮箱前缀：两个 zhang@ 不同域名会撞车
          data: { name: orgName, slug: `ws-${randomBytes(4).toString('hex')}` },
          select: { id: true, name: true, slug: true },
        });

        const user = await tx.user.create({
          // 组织先建，用户直接带上 org_id。
          // 顺序不能反 —— org_id 是 NOT NULL 外键，没有组织就没法插用户
          data: { email, passwordHash, displayName, orgId: org.id, role: 'owner' },
          select: { id: true, email: true, displayName: true, createdAt: true },
        });

        return { user, org };
      });
    } catch (err) {
      // 邮箱唯一索引。不能在事务外"先查再插"：两个并发注册会同时通过检查，
      // 所以真正的一致性保证只能是数据库约束，这里只负责把它翻译成 409
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`邮箱已被注册: ${email}`);
      }
      throw err;
    }

    const { token, expiresIn } = this.jwt.sign(created.user.id);
    this.logger.log(`新用户注册: ${email} → 组织 ${created.org.slug}（尚无项目）`);

    return {
      access_token: token,
      token_type: 'Bearer' as const,
      expires_in: expiresIn,
      user: {
        id: created.user.id,
        email: created.user.email,
        display_name: created.user.displayName,
        created_at: created.user.createdAt,
      },
      organization: {
        id: created.org.id,
        name: created.org.name,
        slug: created.org.slug,
      },
      // MVP-B：角色挂在用户上，不再挂在"成员关系"里
      role: 'owner',
      // 项目与密钥不在这里 —— 走 POST /api/v1/projects。
      // 前端拿不到 project 字段时不该当成"出错了"，那正是下一步要做的事
    };
  }

  /**
   * 登录。
   *
   * 三条安全纪律，每条都对应一类真实攻击：
   *   ① 账号不存在时也跑一次 scrypt —— 否则耗时差异能用来枚举邮箱
   *   ② 账号不存在和密码错误返回**同一句话** —— 否则错误信息成了探测工具
   *   ③ 先判 isActive 再判密码？不 —— 密码对了才谈得上"账号被停用"，
   *      否则给攻击者一个"这个账号存在"的信标
   */
  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        displayName: true,
        passwordHash: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (user === null) {
      // 故意跑一次真 scrypt（结果一定为 false），把耗时拉平
      await verifyPassword(dto.password, DUMMY_PASSWORD_HASH);
      this.logger.warn(`登录失败（账号不存在）: ${email}`);
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    const passwordOk = await verifyPassword(dto.password, user.passwordHash);
    if (!passwordOk) {
      this.logger.warn(`登录失败（密码错误）: ${email}`);
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    if (!user.isActive) {
      this.logger.warn(`登录失败（账号已停用）: ${email}`);
      throw new UnauthorizedException('账号已停用，请联系管理员');
    }

    // 只有成功才更新。失败也更新的话，这一列就失去了"上次成功登录"的含义
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const { token, expiresIn } = this.jwt.sign(user.id);
    this.logger.log(`登录成功: ${email}`);

    return {
      access_token: token,
      token_type: 'Bearer' as const,
      expires_in: expiresIn,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.displayName,
        created_at: user.createdAt,
      },
    };
  }

  /**
   * 当前用户 + 他所属的那个组织。
   *
   * 看板用它在刷新后恢复"我是谁"（顶部显示邮箱和组织名）。
   * passwordHash 绝不出现在返回值里 —— 这是本文件唯一需要时刻警惕的一条。
   *
   * MVP-B：`organizations` 数组改成了单个 `organization` 对象。
   * 数组是"一人多组织"时代的遗留形状，留着它前端就要写 `[0]`，
   * 而那个 `[0]` 会让"其实应该是 1 个"这件事看不出来。
   */
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        isActive: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
    });

    if (user === null) {
      // 守卫刚刚才查过它，走到这里说明查询之间被删了
      throw new NotFoundException('用户不存在');
    }

    return {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      is_active: user.isActive,
      role: user.role,
      created_at: user.createdAt,
      last_login_at: user.lastLoginAt,
      organization: {
        id: user.organization.id,
        name: user.organization.name,
        slug: user.organization.slug,
      },
    };
  }
}
