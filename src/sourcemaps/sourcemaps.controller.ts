import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
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
 * Sourcemap 上传（M3；M4-S2 改为按项目 + 私钥鉴权）。
 *
 * ── 接口契约（CLI 照着写）──────────────────────────────────────────────
 *   POST /api/v1/projects/:projectId/sourcemaps
 *   Content-Type: multipart/form-data
 *   Authorization: Bearer argus_sec_...   （或 x-argus-secret）
 *
 *     release        = "web@1.0.0"                  必须与 SDK 上报的 release 逐字节一致
 *     artifact_path  = "/assets/index-a1b2c3.js"    以 / 开头的 pathname，不带 origin/query
 *     file           = <map 二进制>                  字段名固定为 file
 *
 *   201 { release_id, artifact_path, size_bytes, reused }
 *   400 路径不合法 / release 超长 / 缺字段
 *   401 私钥缺失、错误，或不属于该项目
 *   404 :projectId 不是合法 UUID（进不了本方法）
 *   413 文件超过 50MB
 *
 * ── 为什么路由里带 projectId，而不是从私钥反查 ───────────────────────────
 * 反查也能做到（私钥哈希 → 找 project_keys → 拿 projectId），但那样
 * "往哪个项目写"就完全由请求体决定，路由上看不出来；而这是**写**操作，
 * 出错了是脏数据。带上 projectId 后，日志、审计、限流都能按 URL 归类，
 * 且私钥必须与路由里的项目匹配 —— 拿 A 项目的私钥往 B 项目传，直接 401。
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
 * 计划里写了 GET，但 M3 真正需要的是"Worker 按 (release, path) 查"，那是
 * 服务内部查询、不是 HTTP 接口。对外暴露列表属于看板的设置页（FR-8.13），
 * 等做到那一步再加，避免现在先定一个没人会用的形状。
 */
@Controller('api/v1/projects/:projectId/sourcemaps')
export class SourcemapsController {
  constructor(
    private readonly service: SourcemapsService,
    private readonly keys: KeysService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCEMAP_BYTES } }))
  async upload(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: MulterFile | undefined,
    @Body() body: UploadSourcemapDto,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-argus-secret') legacySecret: string | undefined,
  ): Promise<UploadSourcemapResult> {
    // 鉴权放在读 body 之前：未授权请求不该有机会触发 multer 的解析开销
    await this.keys.assertSecret(projectId, authorization ?? legacySecret);

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
