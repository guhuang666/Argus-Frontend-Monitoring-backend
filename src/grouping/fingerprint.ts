/**
 * 指纹 —— M2 的第二道工序（对应 SRS FR-4.1 / FR-4.2，产物落 error_groups）。
 *
 * 输入是 error_events 上的三个原始列（type / message / stack），输出是一串
 * 64 位十六进制，写进 error_groups.fingerprint（varchar(64)，正好一位不差）。
 * 同一个 bug 的多次发生 → 同一个指纹 → 同一个问题；指纹抖一次，看板上就多一个
 * 假问题，所以这里的每一步都必须是**纯函数**，不许有时间/随机/环境分支。
 *
 * ── 归一化分两条线，不要混 ──────────────────────────────────────────────
 *   message 走 normalize.ts 的 normalizeMessage()（去 UUID / URL / hex / 数字…）
 *   stack   走本文件的 parseFrames() + frameFile()（去 origin / hash / 行号）
 * 两条线都不回写数据库：归一化只发生在算指纹这一步（TC-10：指纹输入必须能从
 * 原始载荷无损重建）。
 *
 * ── 三处拍板（改这里之前先读这三条）────────────────────────────────────
 * ① **帧文件名要剥 hash，且必须剥在签名里，不能只剥在 culprit 里**。
 *    如果签名用的是 index-a1b2c3.js 原文，那么每次发版 hash 一变，同一个 bug
 *    就换一个指纹 —— 「同一 bug 归并成一个问题」当场失效。剥 hash 是签名正确性的
 *    前提，不是显示层的装饰。
 * ② **main.a1b2c3d4.chunk.js → main.chunk.js**：`.chunk.js` 这类后缀保留，
 *    夹在中间、≥4 位的纯十六进制段一律当 hash 剥掉。理由同①（webpack 的
 *    contenthash 每次构建都变）；代价是同一次构建里若真有 main.<两个不同hash>.chunk.js
 *    会被并成一条 —— 属于可接受的**过度归并**（错误方向是"两个问题并成一个"，
 *    比"一个问题裂成两百个"轻得多）。
 * ③ **origin / 端口 / 目录一律丢掉，只留最后一段文件名**：
 *    http://127.0.0.1:8017/assets/index-a1b2c3.js → index.js
 *    本地 / 预发 / 生产三套环境（域名、端口、CDN 前缀全不同）必须算出同一个指纹，
 *    否则同一个人写的同一个 bug 会变成三个问题。
 *    代价：不同目录下的同名文件（/a/util.js 与 /b/util.js）无法区分 —— 但它们
 *    通常还有函数名和 message 参与区分，且过度归并方向同上。
 *
 * ── 刻意**不**参与签名的东西 ────────────────────────────────────────────
 *   · 行号 / 列号：任何一次编辑都会平移，参与就是每次提交换一批指纹
 *   · 超过 FRAME_LIMIT 的深层帧：深栈里的框架内部帧与业务无关，且长度抖动大
 *   · 完整 message：它已经单独作为 canonical 的一段参与，且经归一化处理
 */

import { createHash } from 'node:crypto';

import { normalizeMessage } from './normalize';

/**
 * 指纹算法及其输入的版本，写进 error_groups.grouping_version。
 *
 * 唯一约束是 (grouping_version, fingerprint)（MVP 去掉了 project_id），所以分组版本是
 * 「同一条错误在新旧算法下可以并存」的开关（FR-4.12：M3 做符号化重算时靠它
 * 保证历史 times_seen 不断档）。
 *
 * **改 normalize.ts 的 RULES、或改本文件任何影响 canonical 的逻辑，
 * 都必须同步 bump 这个常量。** 否则同一个 version 下混进两套指纹，
 * 唯一索引挡不住，归并会静默漂移 —— 这类问题事后极难查。
 */
export const GROUPING_VERSION = 'v1-raw';

/** 参与签名的帧数上限。取 3：够区分调用路径，又不至于被深栈抖动带偏 */
const FRAME_LIMIT = 3;

/** error_groups.title 是 varchar(500) */
const TITLE_LIMIT = 500;

/** error_groups.culprit 是 varchar(500)。文件名一般不超长，但栈是外部输入 */
const CULPRIT_LIMIT = 500;

/** 一帧。字段只保留指纹用得上的两样：文件与函数名 */
export interface Frame {
  /**
   * 栈原文里的位置，**保留原样**：可能带 origin、端口、目录、query。
   * 参与指纹前一律经 frameFile() 归一化，别拿它直接拼签名。
   */
  file: string;
  /** 函数名；匿名帧为 null（不是空串 —— 空串会被误认为"有个叫空的函数"） */
  fn: string | null;
}

/**
 * 一条 V8 栈帧。三种行形都要吃下：
 *
 *     at http://127.0.0.1:8017/src/main.js:348:13              ← 匿名帧，没有函数名
 *     at HTMLBodyElement.handler (http://…/main.js:355:13)     ← 具名帧
 *     at async loadData (http://…/api.js:12:5)                 ← async 前缀
 *
 * 为什么这么写：尾部锚定 `:(\d+):(\d+)\)?$` + 惰性量词，效果是**从右往左切**
 * 行号列号。URL 自己就带冒号（http://host:8017/…），从左往右数第一个冒号会把
 * `http` 当成文件名。行号/列号限定为纯数字，正好卡住右侧这两个字段。
 *
 * 匹配不上的行直接丢弃，典型是 `at async Promise.all (index 0)` —— 它没有
 * 文件与行列，锚不住任何代码位置，留着只会污染签名。
 * 只处理 V8（Chrome / Edge / Node）格式；SDK 采集面就是浏览器，Firefox 的
 * `fn@url:1:1` 形状不认。
 */
const AT_LINE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * 解析 stack 原文 → 帧数组。第 0 帧是最内层（出错点）。
 *
 * @param stack 整段栈原文；resource 通道没有栈，传空串或 null 都得到 []
 */
export function parseFrames(stack?: string | null): Frame[] {
  if (typeof stack !== 'string' || stack === '') return [];

  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    const m = AT_LINE.exec(line);
    if (m === null) continue; // 首行 `TypeError: xxx` 和 Promise.all(index 0) 都走这里

    let fn: string | null = m[1] === undefined ? null : m[1].trim();
    let file = m[2].trim();

    // async 有两个去处：`at async foo (…)` 落在函数名上，`at async http://…`
    // 因为没有括号会粘在 file 上。async 只是调用方式，不是函数身份，
    // 摘掉它才能让同步/异步两条路径指向同一个函数。
    if (fn !== null) {
      fn = fn.replace(/^async\s+/, '');
      if (fn === '') fn = null;
    } else {
      file = file.replace(/^async\s+/, '');
    }

    frames.push({ file, fn });
  }
  return frames;
}

/** 纯十六进制段，≥4 位（checkout.9f2c.js 里的 hash 只有 4 位，门槛不能再高） */
const HEX_SEGMENT = /^[0-9a-f]{4,}$/i;

/**
 * 剥掉文件名里的构建 hash（FR-4.1 要求）。
 *
 *     index-a1b2c3.js            → index.js
 *     checkout.9f2c.js           → checkout.js
 *     main.a1b2c3d4.chunk.js     → main.chunk.js
 *     vendor~main.9f2c.js        → vendor~main.js
 *     main.min.js                → main.min.js（min 不是纯十六进制，天然免疫）
 *     jquery-3.7.1.min.js        → 原样（版本号每段都太短，不会被误伤）
 *     /assets/index-a1b2c3.js    → /assets/index.js（目录部分原样保留）
 *
 * 两条护栏：
 *   · **主名本身绝不整体剥掉** —— 1234.js 这种「chunk id 当文件名」剥完就只剩
 *     `js` 了，比不剥更糟。所以主名只在带连字符时才剥尾段（index-a1b2c3 → index）。
 *   · 只认 ≥4 位纯十六进制，`min` / `chunk` / `umd` 这些全字母或含非十六进制
 *     字母的后缀（h/n/k/w/s/m…）一个都碰不到。
 */
export function stripFileHash(file: string): string {
  if (typeof file !== 'string' || file === '') return file;

  const cut = file.lastIndexOf('/');
  const dir = cut === -1 ? '' : file.slice(0, cut + 1);
  const base = cut === -1 ? file : file.slice(cut + 1);
  if (base === '') return file;

  const parts = base.split('.');
  let head = parts.shift() as string;

  // 主名内的 -HASH：只剥最后一个连字符段，且剥完主名必须还剩东西
  const dashed = head.split('-');
  if (dashed.length > 1 && HEX_SEGMENT.test(dashed[dashed.length - 1])) {
    const trimmed = dashed.slice(0, -1).join('-');
    if (trimmed !== '') head = trimmed;
  }

  return dir + [head, ...parts.filter((p) => !HEX_SEGMENT.test(p))].join('.');
}

/** `<anonymous>` / `<eval>` / native 这类伪文件锚不住真实代码，一律视为"没有文件" */
const PSEUDO_FILE = /^(<.*>|native|unknown location)$/i;

/**
 * 帧文件 → 参与指纹的形式：只留最后一段文件名，去掉 query/fragment，再剥 hash。
 *
 * 空串表示"这一帧没有可用的文件"，调用方应跳过它（别写进签名，也别当 culprit）。
 */
function frameFile(file: string): string {
  let f = file.trim();
  if (f === '') return '';

  // 先切 query/fragment：它们的值随请求变，且 query 里可能还有 '/'，先切才不乱
  const mark = f.search(/[?#]/);
  if (mark !== -1) f = f.slice(0, mark);

  // 丢 origin、端口、目录（拍板 ③）
  const cut = f.lastIndexOf('/');
  if (cut !== -1) f = f.slice(cut + 1);

  if (f === '' || PSEUDO_FILE.test(f)) return '';
  return stripFileHash(f);
}

/**
 * 帧签名：取前 FRAME_LIMIT 帧，只用「文件名:函数名」，用 ` -> ` 连接。
 *
 * 不用行号（见文件头）；文件名已经过 frameFile()，所以换域名、换端口、换目录
 * 布局都不会改变签名。
 *
 * 无帧/全是伪文件时返回空串，此时指纹退化为 type + message 两段 ——
 * resource 通道就是这种情况（SDK 发的 stack 是空串），它靠 `<asset>` 占位符
 * 保证"1000 张图失败 → 1 个问题"。
 */
export function frameSignature(frames: Frame[]): string {
  return frames
    .map((frame) => ({ file: frameFile(frame.file), fn: frame.fn }))
    .filter((frame) => frame.file !== '')
    .slice(0, FRAME_LIMIT)
    .map((frame) => `${frame.file}:${frame.fn ?? '?'}`)
    .join(' -> ');
}

/**
 * 算指纹：sha256(type | 归一化 message | 帧签名)，64 位十六进制。
 *
 * 用 `|` 分隔三段而不是直接拼接：分隔符让「type 的尾巴 + message 的头」这类
 * 跨段碰撞不可能发生（type=AB + message=C 与 type=A + message=BC 会撞车）。
 * 三段里都不含 `|`，所以拼接是无歧义的。
 *
 * 不传 stack（或用 resource 通道的空栈）是合法的：签名退化成空串，指纹仍然稳定。
 */
export function computeFingerprint(input: {
  type: string;
  message: string;
  stack?: string | null;
}): string {
  const canonical = [
    input.type,
    normalizeMessage(input.message),
    frameSignature(parseFrames(input.stack)),
  ].join('|');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * 问题标题：`type: 归一化 message`，截到 TITLE_LIMIT。
 *
 * 用**归一化后**的 message：标题要能横向对比，带 UUID 的原文每行都不一样。
 * 截断用码点而不是 slice：Postgres 的 varchar(500) 数的是字符，emoji 算 1 个，
 * 而 JS 的 length 数的是 UTF-16 码元（emoji 算 2 个）—— 按 length 切既可能
 * 少切，也可能把代理对切成两半，落库时变成半个字符。
 */
export function buildTitle(type: string, message: string): string {
  return truncate(`${type}: ${normalizeMessage(message)}`, TITLE_LIMIT);
}

/**
 * 疑似责任位置：第一个有文件的帧，形如 `index.js:renderSummary`。
 *
 * **没有帧就返回 null** —— error_groups.culprit 可空正是为这个准备的：
 * resource 通道没有栈，硬塞空串会让"没有责任位置"和"责任位置是空"混在一起。
 *
 * 文件名与签名走同一套归一化（剥 origin、剥 hash），保证看板上显示的 culprit
 * 与指纹算出来的是同一个文件。
 */
export function buildCulprit(frames: Frame[]): string | null {
  for (const frame of frames) {
    const file = frameFile(frame.file);
    if (file === '') continue;
    return truncate(`${file}:${frame.fn ?? '?'}`, CULPRIT_LIMIT);
  }
  return null;
}

/** 按**码点**截断（见 buildTitle 的注释），不追加省略号 —— 那是渲染层的事 */
function truncate(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join('');
}
