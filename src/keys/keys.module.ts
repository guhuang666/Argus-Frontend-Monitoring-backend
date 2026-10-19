import { Global, Module } from '@nestjs/common';
import { KeysService } from './keys.service';

/**
 * 标记 @Global：上报、性能、上传、项目四个模块都要用它，
 * 逐个 imports 只会制造无意义的样板。全局注册的代价是模块边界变模糊，
 * 所以这里只放 KeysService 一个东西。
 */
@Global()
@Module({
  providers: [KeysService],
  exports: [KeysService],
})
export class KeysModule {}
