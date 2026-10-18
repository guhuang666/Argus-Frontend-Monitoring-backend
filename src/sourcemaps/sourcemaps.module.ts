import { Module } from '@nestjs/common';
import { SourcemapsController } from './sourcemaps.controller';
import { SourcemapsService } from './sourcemaps.service';

/**
 * Sourcemap 上传（M3）。
 *
 * 只注册到 API 进程（app.module.ts）—— 落盘与入库都发生在 HTTP 请求里，
 * worker 进程完全不需要它。将来做符号化时，worker 需要的是**读**磁盘上已存好的
 * map，那属于另一个模块（sourcemaps 的读取侧），不该复用本模块的写入口。
 */
@Module({
  controllers: [SourcemapsController],
  providers: [SourcemapsService],
  exports: [SourcemapsService],
})
export class SourcemapsModule {}
