/**
 * FileInterceptor 交出来的文件对象，只列我们用得到的字段。
 *
 * ── 为什么不写 `Express.Multer.File` ────────────────────────────────────
 * 那需要 `@types/multer`，而本项目没装它。multer 本身是
 * `@nestjs/platform-express` 的传递依赖（运行时一定存在），但为了一个类型
 * 引入新的 devDependency、并让 `Express.Multer` 命名空间变成隐式依赖，
 * 不值得。按实际用到的字段自己声明更直白。
 *
 * ── 为什么 buffer 一定有 ────────────────────────────────────────────────
 * multer 在没有传 `storage` 选项时默认用内存存储，Nest 的 FileInterceptor
 * 也没给 storage，所以文件内容是 `buffer` 而不是磁盘路径。
 */
export interface MulterFile {
  /** 文件内容（内存存储） */
  buffer: Buffer;
  /** 字节数，multer 已经算好，不必再取 buffer.length */
  size: number;
  mimetype: string;
  originalname: string;
  /** 表单里这个文件对应的字段名，应当恒为 'file' */
  fieldname: string;
}
