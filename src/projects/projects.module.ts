import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * 项目读取。仅 API 进程注册（worker 不需要，见 issues.module.ts 的同类说明）。
 *
 * 不需要 imports PrismaModule / KeysModule：两者都是 @Global。
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
