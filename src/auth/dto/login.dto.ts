import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 登录。
 *
 * 注意这里**没有** @MinLength(8)：密码规则属于"注册时能接受什么"，
 * 登录只负责比对。给登录也加上长度限制，会让"规则上线前注册的老密码"
 * 直接被 400 挡在门外 —— 而它其实可能是对的。
 */
export class LoginDto {
  @IsEmail({}, { message: 'email 不是合法邮箱' })
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1, { message: '密码不能为空' })
  @MaxLength(128)
  password!: string;
}
