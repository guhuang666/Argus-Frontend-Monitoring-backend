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
import { UploadSourcemapDto } from './dto/upload-sourcemap.dto';
import type { MulterFile } from './multer-file';
import { MAX_SOURCEMAP_BYTES } from './sourcemaps.constants';
import { SourcemapsService } from './sourcemaps.service';
import type { UploadSourcemapResult } from './sourcemaps.service';

/**
 * Sourcemap 上传（M3）。
 *
 * ── 接口契约（CLI 照着写）──────────────────────────────────────────────
 *   POST /api/v1/sourcemaps
 *   Content-Type: multipart/form-data
 *   x-argus-token: <ARGUS_TOKEN>
 *
 *     release        = "web@1.0.0"                  必须与 SDK 上报的 release 逐字节一致
 *     artifact_path  = "/assets/index-a1b2c3.js"    以 / 开头的 pathname，不带 origin/query
 *     file           = <map 二进制>                  字段名固定为 file
 *
 *   201 { release_id, artifact_path, size_bytes, reused }
 *   400 路径不合法 / release 超长 / 缺字段
 *   401 token 不对（或服务端未配置 ARGUS_TOKEN）
 *   413 文件超过 50MB
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
@Controller('api/v1/sourcemaps')
export class SourcemapsController {
  constructor(private readonly service: SourcemapsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCEMAP_BYTES } }))
  upload(
    @UploadedFile() file: MulterFile | undefined,
    @Body() body: UploadSourcemapDto,
    @Headers('x-argus-token') token: string | undefined,
  ): Promise<UploadSourcemapResult> {
    if (file === undefined || file.size === 0) {
      throw new BadRequestException('缺少 file 字段（multipart 字段名必须是 file，且不能为空文件）');
    }

    return this.service.upload({
      release: body.release,
      artifactPath: body.artifact_path,
      file,
      token,
    });
  }
}
