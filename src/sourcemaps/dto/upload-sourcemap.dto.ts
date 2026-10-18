import { IsString, Length } from 'class-validator';
import { MAX_RELEASE_LENGTH } from '../sourcemaps.constants';

/**
 * Sourcemap 上传的表单字段（不含 file，文件走 @UploadedFile）。
 *
 * 为什么 artifact_path 只做 IsString、不在这里做长度/结构校验：
 * 它的规则（前导斜杠、不许 // 与 ..、不许带 origin/query、不许是堆栈位置…）
 * 要和 CLI、Worker 查找侧**逐字节一致**，所以集中在 artifact-path.ts 的
 * `checkArtifactPath()` 里。放在 DTO 会让同一套规则散成两处，正是 M3 最容易
 * 出错的地方。DTO 只负责"字段在不在、是不是字符串"。
 *
 * release 的长度则直接在这里卡住 —— 它没有别的规则，且必须对齐
 * releases.version 的 varchar(100)。
 */
export class UploadSourcemapDto {
  @IsString()
  @Length(1, MAX_RELEASE_LENGTH)
  release!: string;

  @IsString()
  artifact_path!: string;
}
