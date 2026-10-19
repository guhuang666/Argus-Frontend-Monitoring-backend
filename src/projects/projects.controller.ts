import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ProjectsService } from './projects.service';

/**
 * 项目：列表 + 详情。
 *
 *   GET /api/v1/projects        项目列表（看板切换器 + 展示公钥）
 *   GET /api/v1/projects/:id    单个项目 + 全部有效公钥
 *
 * 暂不鉴权：S2 只解决"上报是谁"的问题，管理侧的 JWT 在 S4。
 * 也就是说**现在任何人访问这两个接口都能看到所有项目的公钥** ——
 * 这是已知的、被记录在案的中间状态，不是疏漏（公钥本就是公开信息，
 * 泄露它的后果等于"别人能往你项目灌数据"，而那件事 S6 的限流会兜住）。
 * 真正的洞是"能看到项目名和事件数"，S4 上 JWT 即关闭。
 */
@Controller('api/v1/projects')
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getById(id);
  }
}
