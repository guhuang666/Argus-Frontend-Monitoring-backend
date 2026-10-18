/**
 * artifact_path 的归一化与校验（M3）。
 *
 * ── 为什么单独成一个文件 ────────────────────────────────────────────────
 * 这套规则有**三个使用方**，必须逐字节一致，否则会出现"传上去的是 A、
 * Worker 拿 B 去查、永远匹配不上"这种最难查的错：
 *   ① 上传侧  backend/src/sourcemaps（本模块）
 *   ② CLI    打包时把本地文件路径归一成同一个形式再上传
 *   ③ 查找侧 Worker 符号化时，从堆栈里剥出文件名后按同一个形式查
 *
 * 所以这里**刻意不 import 任何 Nest / Prisma 的东西** —— 纯函数，
 * CLI 可以直接把本文件拷过去用，不需要把整个后端当依赖。
 *
 * ── 存什么形态 ──────────────────────────────────────────────────────────
 * 统一存**以 / 开头的 pathname**：/assets/index-a1b2c3.js
 * 三条不许存（对应 schema.prisma 里 SourcemapFile.artifactPath 的注释）：
 *   · 不带 origin —— 同一份产物可能被 localhost / CDN / 预发域名加载
 *   · 不带 query  —— ?v=2 这类版本参数不属于文件身份
 *   · 不带 :line:col —— 那是堆栈里的位置，不是文件路径
 *
 * **校验而不是悄悄修正**：origin 和 query 一律报错让调用方自己剥干净。
 * 悄悄剥看似友好，但会掩盖 CLI 的 bug（比如它把整条 URL 传上来了），
 * 而且"谁剥的、剥成什么样"会随实现漂移 —— 这正是三个使用方最容易分歧的地方。
 */

/** = sourcemap_files.artifact_path 的 varchar(500) */
export const MAX_ARTIFACT_PATH_LENGTH = 500;

/** 堆栈里的位置形态，如 /assets/a.js:12:34 —— 有人会把它当路径传上来 */
const STACK_POSITION = /:\d+:\d+$/;

/** 失败原因。给机器判断用，不要把文案写进类型里。 */
export type ArtifactPathError =
  | 'empty'
  | 'too_long'
  | 'not_absolute'
  | 'ends_with_slash'
  | 'double_slash'
  | 'dot_segment'
  | 'backslash'
  | 'query_or_fragment'
  | 'stack_position';

/** 校验结果。ok 为 true 时 path 是**可直接入库**的形态 */
export type ArtifactPathCheck =
  | { ok: true; path: string }
  | { ok: false; error: ArtifactPathError; message: string };

/**
 * 校验一条 artifact_path。
 *
 * 只做 trim 这一种"修正" —— 前后空格几乎总是复制粘贴带进来的，
 * 修它不会有歧义。其余一律报错。
 *
 * @param raw 表单里的原始字符串（可能带前后空格）
 */
export function checkArtifactPath(raw: string): ArtifactPathCheck {
  const path = typeof raw === 'string' ? raw.trim() : '';

  if (path === '') {
    return fail('empty', 'artifact_path 不能为空');
  }
  if (path.length > MAX_ARTIFACT_PATH_LENGTH) {
    return fail(
      'too_long',
      `artifact_path 超长: ${path.length} > ${MAX_ARTIFACT_PATH_LENGTH}（列宽上限）`,
    );
  }
  if (!path.startsWith('/')) {
    return fail(
      'not_absolute',
      'artifact_path 必须以 / 开头（存 pathname，不带 origin；如 /assets/index-a1b2c3.js）',
    );
  }
  if (path.includes('\\')) {
    return fail('backslash', 'artifact_path 含反斜杠，请统一用 / 分隔');
  }
  if (path.includes('//')) {
    return fail('double_slash', 'artifact_path 含连续斜杠 //');
  }
  if (path.includes('?') || path.includes('#')) {
    return fail('query_or_fragment', 'artifact_path 不能带 query 或 fragment（? 与 #）');
  }
  if (path.split('/').includes('..')) {
    return fail('dot_segment', 'artifact_path 不能含 .. 段');
  }
  if (STACK_POSITION.test(path)) {
    return fail(
      'stack_position',
      'artifact_path 看起来是堆栈位置（:行:列）而不是文件路径，请传 /assets/app.js 这种形态',
    );
  }
  if (path.endsWith('/')) {
    return fail('ends_with_slash', 'artifact_path 指的是目录，需要具体到文件');
  }

  return { ok: true, path };
}

function fail(error: ArtifactPathError, message: string): ArtifactPathCheck {
  return { ok: false, error, message };
}

/* ==========================================================================
 * 第三个使用方：Worker 符号化时，从堆栈帧反算 artifact_path
 * ========================================================================*/

/** `scheme://host[:port]` —— 只剥协议与主机，保留后面的路径 */
const ORIGIN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/;

/** 伪文件：锚不住真实产物，一律视为"没有文件"（与 fingerprint.ts 的 PSEUDO_FILE 同义） */
const PSEUDO_FILE = /^(<.*>|native|unknown location)$/i;

/**
 * 堆栈帧里的文件位置 → artifact_path。**M3 三个使用方的第三个。**
 *
 *   ① 上传侧（sourcemaps.controller）  校验 CLI 传上来的路径 —— checkArtifactPath
 *   ② CLI（cli/paths.ts）              磁盘路径 → 站点路径
 *   ③ 本函数（Worker 符号化）          堆栈 URL → 用来查表的路径
 *
 * 三者必须对同一个输入给出同一个结果，否则表现是"map 明明传上去了却永远匹配不上"，
 * 而且**不报错**，只在看板上体现为"未符号化"。
 *
 * ── 例 ────────────────────────────────────────────────────────────────
 *   https://app.example.com/assets/index-B3obYmGb.js  → /assets/index-B3obYmGb.js
 *   http://127.0.0.1:8017/src/main.js                 → /src/main.js
 *   https://cdn.example.com/app/assets/a.js?v=8f2a    → /app/assets/a.js
 *   webpack:///src/main.js                            → /src/main.js
 *   assets/index.js                                   → /assets/index.js
 *   /assets/index.js:10:5                             → /assets/index.js
 *   <anonymous> / native / ''                         → null
 *
 * ── 为什么用 pathname 而不是完整 URL ──────────────────────────────────
 * 同一份产物可能被 localhost / CDN / 预发域名加载，带上 origin 会让同一条记录
 * 分裂成多条，跨环境的堆栈就永远匹配不上。这与 fingerprint 剥 origin 的
 * 取舍同源（但**注意**：指纹丢目录、这里保留目录，两者不能混用）。
 *
 * ── 为什么不自己拼，而是最后再过一遍 checkArtifactPath ────────────────
 * 让"Worker 能算出来的形态"和"上传侧愿意接受的形态"由**同一段代码**定义。
 * 换句话说：本函数永远不会产出上传侧会拒绝的路径，三个使用方天然收敛。
 *
 * @returns 以 / 开头的 artifact_path；伪文件或无法归一化时返回 null
 */
export function stackFrameToArtifactPath(frameFile: string): string | null {
  if (typeof frameFile !== 'string') return null;

  let current = frameFile.trim();
  if (current === '') return null;

  // ① 先剥 `:行:列`。parseFrames() 已经切过，但本函数可能被单独调用，
  //    不能依赖上游；而且必须先于 query 剥离 —— `a.js?v=1:10:5` 的尾巴也在末尾
  current = current.replace(STACK_POSITION, '');

  // ② 剥 query / fragment（?v=2 是版本参数，不属于文件身份）
  const mark = current.search(/[?#]/);
  if (mark !== -1) current = current.slice(0, mark);

  // ③ 剥协议与主机，只留路径
  current = current.replace(ORIGIN, '');

  if (current === '' || PSEUDO_FILE.test(current)) return null;

  // ④ 相对路径补前导斜杠（堆栈里偶尔出现 `src/main.js` 这种形态）
  if (!current.startsWith('/')) current = `/${current}`;

  // ⑤ 交给同一套校验收口：不含 `//`、`..`、反斜杠等
  const checked = checkArtifactPath(current);
  return checked.ok ? checked.path : null;
}
