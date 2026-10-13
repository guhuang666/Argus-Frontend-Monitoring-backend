import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Prisma 客户端在 Nest 里的包装。
 *
 * 为什么不直接在业务代码里 new PrismaClient()，而要包一层：
 *   ① 连接池必须全应用共用一份。每个请求 new 一个 = 每个请求一条新连接池，
 *      几百个请求之后 PostgreSQL 的 max_connections（默认 100）就被打满。
 *   ② 连接的生命周期要跟着应用走：Nest 启动时连上、关闭时断开，
 *      而不是散落在各个 service 里无人回收。
 *
 * 用法：在构造函数里声明 `private readonly prisma: PrismaService` 即可注入
 * （PrismaModule 标了 @Global，业务模块不必逐个 imports）。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  /** Nest 启动时自动调用 —— 连接池在这一刻建立，而不是等第一个请求 */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma 已连接 PostgreSQL');
  }

  /** 应用关闭时自动调用，优雅断连，避免连接泄漏到数据库侧 */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
