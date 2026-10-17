import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 通用分页参数。
 *
 * 原先 error-events.controller.ts 与 performance.controller.ts 各留了一份副本，
 * 注释里写着"出现第 3 个读接口时，就是把它抽到共享位置的时机"——
 * issues（问题列表）是第 3 个，所以抽到这里，两边同步改成 import。
 *
 * ⚠️ @Type(() => Number) 不能省：main.ts 里的 ValidationPipe 关掉了
 * enableImplicitConversion，query 参数到手是字符串，"2" 过不了 @IsInt()。
 */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
