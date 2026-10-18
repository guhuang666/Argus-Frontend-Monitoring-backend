/**
 * Sourcemap 上传的共享常量（M3）。
 *
 * 两个上限都直接对齐数据库列宽，避免"校验了一套、写库时才发现超长"：
 *   MAX_RELEASE_LENGTH = releases.version 的 varchar(100)
 * artifact_path 的 500 上限定义在 artifact-path.ts 里 —— 那个文件要单独给
 * CLI 复用，保持自包含比集中放常量更重要。
 */

/** 单个 .map 的体积上限。实测一条压缩产物的 map 通常 1~10MB，50MB 留足余量 */
export const MAX_SOURCEMAP_BYTES = 50 * 1024 * 1024;

/** = releases.version 列宽 */
export const MAX_RELEASE_LENGTH = 100;

/**
 * .map 落盘根目录。
 *
 * **写成函数而不是模块级常量**：`ConfigModule.forRoot()` 是在模块实例化时才
 * 把 .env 灌进 process.env 的，而模块级常量会在文件首次被 import 时求值 ——
 * 那时 process.env 可能还是空的。函数延迟到调用时才读，顺序就无关了。
 */
export function uploadsRoot(): string {
  return process.env.UPLOADS_DIR ?? 'uploads';
}
