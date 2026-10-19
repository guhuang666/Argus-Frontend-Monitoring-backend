import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 注册。
 *
 * 注册的语义（M4-S4 的选择）：**注册一个账号 = 建一个属于你的组织 + 一个默认项目 + 一对密钥**。
 *
 * 为什么不是"注册后加入已有的组织"：那样所有人共享一个租户，多租户就成了摆设 ——
 * 两个人能看到对方的报错。而"一人一个组织"让隔离在注册那一刻就成立，
 * 也让 FR-5.8 的接入流程（拿到公钥贴进代码）自然落在同一步里。
 *
 * 代价：没有"邀请同事加入我的组织"这个能力（FR-5.5 的 P1 部分，暂未做）。
 */
export class RegisterDto {
  @IsEmail({}, { message: 'email 不是合法邮箱' })
  @MaxLength(255)
  email!: string;

  /**
   * 至少 8 位。上限 128 是因为 scrypt 的输入长度直接影响计算量，
   * 一个 10MB 的"密码"能把服务器拖死（这叫密码长度 DoS）。
   */
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  display_name?: string;

  /** 组织名。不传则由邮箱前缀生成 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  organization_name?: string;
}
