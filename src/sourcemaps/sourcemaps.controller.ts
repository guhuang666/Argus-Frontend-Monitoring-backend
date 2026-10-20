import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { KeysService } from '../keys/keys.service';
import { UploadSourcemapDto } from './dto/upload-sourcemap.dto';
import type { MulterFile } from './multer-file';
import { MAX_SOURCEMAP_BYTES } from './sourcemaps.constants';
import { SourcemapsService } from './sourcemaps.service';
import type { UploadSourcemapResult } from './sourcemaps.service';

/**
 * Sourcemap 上传（M3；M4-S2 按项目 + 私钥鉴权；MVP-Util 去掉 URL 里的 projectId）。
 *
 * ── 接口契约（CLI 照着写）──────────────────────────────────────────────
 *   POST /api/v1/sourcemaps
 *   Content-Type: multipart/form-data
 *   Authorization: Bearer argus_sec_...   （或 x-argus-secret）
 *
 *     release        = "web@1.0.0"                  必须与 SDK 上报的 release 逐字节一致
 *     artifact_path  = "/assets/index-a1b2c3.js"    以 / 开头的 pathname，不带 origin/query
 *     file           = <map 二进制>                  字段名固定为 file
 *
 *   201 { release_id, artifact_path, size_bytes, reused }
 *   400 路径不合法 / release 超长 / 缺字段
 *   401 私钥缺失、错误，或已吊销
 *   413 文件超过 50MB
 *
 * ── 为什么没有 projectId 了（与早期版本的差别）─────────────────────────
 * 曾经是 `POST /projects/:projectId/sourcemaps`，要求客户端同时给出项目 id 和私钥。
 * 理由是"路由上能看出往哪个项目写"。但那个理由站不住：
 *
 *   私钥本身就是**项目级**凭据 —— `project_keys` 这一行就带 project_id，
 *   `sha256(私钥)` 反查一次就得到项目。多加一个 projectId 只是让客户端
 *   把"我是哪个项目"说两遍，然后服务端还要检查两遍说的是不是同一个项目。
 *
 * 更糟的是它的失败模式：两个值配错时只能回一句 401，使用者完全看不出
 * 是"私钥错了"还是"项目选错了"。删掉 projectId 之后，这类错误**不存在**了 ——
 * 调用方没有机会说错。
 *
 * 代价：URL 上不再显示项目。日志里在解析后补一条 project=xxx 即可，
 * 而"审计按项目归类"这件事本来就要先解析才能做。
 *
 * ── 关于 413 不用自己写 ─────────────────────────────────────────────────
 * FileInterceptor 传了 `limits.fileSize`，multer 会抛 `LIMIT_FILE_SIZE`，
 * 而 Nest 的 `multer.utils.transformException` 会把它映射成
 * `PayloadTooLargeException`（413）。已核对 @nestjs/platform-express 实现，
 * 不需要自定义异常过滤器。
 *
 * ── 为什么字段名必须是 file ─────────────────────────────────────────────
 * `FileInterceptor('file')` 里的字符串就是表单字段名。对不上时 multer 抛
 * `LIMIT_UNEXPECTED_FILE`，Nest 转成 400。所以下面的 `!file` 分支只兜
 * "整个表单没带文件"和"带了 0 字节文件"两种。
 *
 * ── 为什么 GET 列表暂时没有 ─────────────────────────────────────────────
 * M3 真正需要的是"Worker 按 (release, path) 查"，那是服务内部查询、
 * 不是 HTTP 接口。对外暴露列表属于看板的设置页（FR-8.13），等做到那一步再加。
 */
@Controller('api/v1/sourcemaps')
export class SourcemapsController {
  constructor(
    private readonly service: SourcemapsService,
    private readonly keys: KeysService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCEMAP_BYTES } }))
  async upload(
    @UploadedFile() file: MulterFile | undefined,
    @Body() body: UploadSourcemapDto,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-argus-secret') legacySecret: string | undefined,
  ): Promise<UploadSourcemapResult> {
    // 鉴权放在读 body 之前：未授权请求不该有机会触发 multer 的解析开销
    // 这一步同时完成了"我是哪个项目"的解析 —— projectId 由服务端反查，不由客户端声明
    const projectId = await this.keys.resolveProjectBySecret(authorization ?? legacySecret);

    if (file === undefined || file.size === 0) {
      throw new BadRequestException('缺少 file 字段（multipart 字段名必须是 file，且不能为空文件）');
    }

    return this.service.upload({
      projectId,
      release: body.release,
      artifactPath: body.artifact_path,
      file,
    });
  }
}
