/** 挂在 request 上的登录用户（由 JwtAuthGuard 填充） */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  /**
   * 所属组织（MVP-B：一个用户只属于一个组织，所以是单个值而不是数组）。
   *
   * 为什么放在这里而不是每次现查：它决定了"你能看哪些项目"，
   * 是每个鉴权请求都要用的东西，而 JwtAuthGuard 为了判断 isActive
   * 本来就要查一次 users —— 顺手带上这一列，热路径零额外查询。
   */
  orgId: string;
  /** owner / admin / member（FR-5.5）。目前只用来判断"能不能新建项目" */
  role: string;
}

/** Express 的 Request 加上守卫塞进去的 user */
export interface RequestWithUser {
  user?: AuthUser;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
}
