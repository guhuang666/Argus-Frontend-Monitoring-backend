import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service';

/**
 * 会话写入（M5 / FR-1.23）。
 *
 * 只有 service、没有 controller：**会话没有独立的对外接口**。
 * 它由错误/性能两条上报链路在入库后顺手 upsert ———
 * 少一个"会话开始"的端点，就少一条能被刷的写路径，
 * 也少了"本地建了会话但服务端没收到"这类不一致。
 *
 * 不 import PrismaModule：PrismaService 由标了 @Global 的 PrismaModule 提供。
 */
@Module({
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
