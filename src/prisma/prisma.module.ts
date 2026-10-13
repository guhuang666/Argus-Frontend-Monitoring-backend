import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * 数据库访问模块。
 *
 * @Global() 让 PrismaService 全局可注入，业务模块不必逐个 imports: [PrismaModule]。
 * 代价是依赖关系不再显式可见 —— 初期图省事这么写；等模块多了如果觉得难追踪，
 * 去掉 @Global 改成每个模块显式声明即可，两种都是常见做法。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
