import { createHash } from 'node:crypto';

import {
  originalPositionFor,
  sourceContentFor,
  TraceMap,
} from '@jridgewell/trace-mapping';
import { stackFrameToArtifactPath } from '../sourcemaps/artifact-path';
import { FRAME_LIMIT } from './fingerprint';
import type { Frame } from './fingerprint';
import { normalizeMessage } from './normalize';

/**
 * Sourcemap 符号化（M3 / FR-3.4、3.8、3.9）。
 *
 * ── 这个文件是**纯逻辑**，不做任何 I/O ────────────────────────────────────
 * 它只负责回答一个问题：**"给我一堆压缩后的帧，帮我还原成源码位置"**。
 * Sourcemap 从哪来（查库 / 读盘 / 缓存）由调用方通过 `resolve` 回调提供。
 *
 * 这样拆的理由：
 *   ① 单测不需要数据库、不需要真实 .map 文件，一个手写的小 map 就够
 *   ② S5 接线时可以在外层加缓存（Redis 的 `argus:sm:{releaseId}:{artifact}`），
 *      不必改动这里的任何一行
 *
 * ── 数据流 ──────────────────────────────────────────────────────────────
 *   Frame（压缩位置）
 *     ↓ stackFrameToArtifactPath()      第三个使用方：URL → /assets/x.js
 *     ↓ resolve(artifactPath)           调用方给 Sourcemap
 *     ↓ originalPositionFor(map, …)     查表
 *   SymbolicatedFrame（源码位置 + 上下文）
 *
 * ── 两处最容易错的地方 ──────────────────────────────────────────────────
 * ① **列号要减 1**：浏览器 / Node 报的列号是 1-based，而 Sourcemap 规范的
 *    生成列号是 **0-based**。不减 1 不会报错，只会把位置整体往右挪一格 ——
 *    在包成一行的产物里，挪一格可能就落到了另一个 token 上。
 *    行号两边都是 1-based，**不要动**。
 * ② **查不到就是查不到**：source 为 null 说明这一帧在 map 里没有对应段
 *    （典型是 map 不完整，或行号越界）。这种情况不能"猜一个"，必须降级
 *    并把 unresolved 传给上层 —— FR-3.9 要求界面上明确标注未还原。
 */

/** 出错行前后各取几行源码 */
const DEFAULT_CONTEXT_LINES = 5;

/** 一帧源码上下文（FR-3.8） */
export interface SourceContext {
  /** 上下文各行的内容（不含行号前缀，展示层自己加） */
  lines: string[];
  /** `lines` 里出错行的下标（0-based） */
  errorIndex: number;
  /** 出错行的绝对行号（1-based） */
  errorLine: number;
  /** `lines[0]` 对应的绝对行号（1-based） */
  startLine: number;
}

/**
 * 一帧还原后的结果。
 *
 * 原始位置（file / fn / line / col）**全部保留** —— 看板要能把
 * "压缩后"与"源码"并排展示，排查时对照两边是最快的办法（FR-3.9）。
 */
export interface SymbolicatedFrame {
  /** 压缩后的文件位置（原样，未归一化） */
  file: string;
  /** 压缩后的函数名（通常是 r / e / t 这种无意义的短名） */
  fn: string | null;
  /** 压缩后的行号（1-based） */
  line: number;
  /** 压缩后的列号（1-based） */
  col: number;
  /** 归一化后的产物路径，如 /assets/index-B3obYmGb.js；null = 伪文件 */
  artifactPath: string | null;
  /** 是否成功还原到源码位置 */
  resolved: boolean;
  /** 源码文件，如 src/pages/OrderList.tsx */
  source: string | null;
  /** 源码行号（1-based） */
  sourceLine: number | null;
  /** 源码列号（1-based，已从 Sourcemap 的 0-based 转回来） */
  sourceCol: number | null;
  /** 源码里的原始函数名 */
  name: string | null;
  /** 源码上下文；map 里没有 sourcesContent 时为 null */
  context: SourceContext | null;
}

/** 一次符号化的汇总结果 */
export interface SymbolicationResult {
  frames: SymbolicatedFrame[];
  /** 成功还原的帧数 */
  resolvedCount: number;
  /** 有可用文件的帧数（分母，用于评估还原覆盖率） */
  withFileCount: number;
  /**
   * 所有"有文件"的帧都还原成功。
   *
   * S5 用它决定这一批帧能不能拿去算 `v2-symbolicated` 的指纹：
   * 只要有一帧没还原，签名就会混进压缩位置，那样的 v2 是不完整的
   * （见 fingerprint.ts 对 GROUPING_VERSION 的纪律）。
   *
   * 注意：**无帧**（resource 通道）时返回 false —— 没有可还原的东西，
   * 调用方应当继续走 v1 路径。
   */
  allResolved: boolean;
}

/** 调用方提供的查表函数：产物路径 → Sourcemap；没有就返回 null */
export type SourcemapResolver = (artifactPath: string) => TraceMap | null;

/**
 * 把压缩后的帧还原成源码位置。
 *
 * @param frames  parseFrames() 的产物
 * @param resolve 产物路径 → Sourcemap
 * @param options.contextLines 出错行前后各取几行，默认 5（FR-3.8）
 */
export function symbolicateFrames(
  frames: Frame[],
  resolve: SourcemapResolver,
  options: { contextLines?: number } = {},
): SymbolicationResult {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;

  const out: SymbolicatedFrame[] = [];
  let resolvedCount = 0;
  let withFileCount = 0;

  for (const frame of frames) {
    // 第三个使用方：完整 URL → /assets/x.js
    const artifactPath = stackFrameToArtifactPath(frame.file);

    const base: SymbolicatedFrame = {
      file: frame.file,
      fn: frame.fn,
      line: frame.line,
      col: frame.col,
      artifactPath,
      resolved: false,
      source: null,
      sourceLine: null,
      sourceCol: null,
      name: null,
      context: null,
    };

    if (artifactPath === null) {
      out.push(base);
      continue;
    }
    withFileCount += 1;

    const map = resolve(artifactPath);
    if (map === null) {
      out.push(base);
      continue;
    }

    // ⚠️ 列号 1-based → 0-based；行号不动。
    // Math.max(0, …) 是防御：规范里列号最小是 0，减成负数会让二分查找失效
    const pos = originalPositionFor(map, {
      line: frame.line,
      column: Math.max(0, frame.col - 1),
    });

    if (pos.source === null || pos.line === null) {
      // map 里没有这一段（map 不完整，或行号越界）—— 不猜，交给上层降级
      out.push(base);
      continue;
    }

    resolvedCount += 1;
    out.push({
      ...base,
      resolved: true,
      source: pos.source,
      sourceLine: pos.line,
      // Sourcemap 的列号是 0-based，展示时转回 1-based，与行号口径一致
      sourceCol: pos.column === null ? null : pos.column + 1,
      name: pos.name,
      context: buildContext(
        sourceContentFor(map, pos.source),
        pos.line,
        contextLines,
      ),
    });
  }

  return {
    frames: out,
    resolvedCount,
    withFileCount,
    allResolved: withFileCount > 0 && resolvedCount === withFileCount,
  };
}

/**
 * 从 sourcesContent 里切出出错行前后各 N 行。
 *
 * 三种情况返回 null：
 *   · map 没内嵌源码（sourcesContent 缺失）—— 只能显示位置，显示不了代码
 *   · 行号越界（map 的 sourcesContent 与源码不同步）
 * 返回 null 时调用方仍应把位置告诉用户：**"知道在哪"比"看到代码"更重要**。
 */
function buildContext(
  content: string | null,
  errorLine: number,
  contextLines: number,
): SourceContext | null {
  if (content === null) return null;

  // 三种换行都吃：构建工具产出的 sourcesContent 可能有 \r\n（Windows 上常见）
  const lines = content.split(/\r\n|\r|\n/);
  if (errorLine < 1 || errorLine > lines.length) return null;

  const index = errorLine - 1;
  const start = Math.max(0, index - contextLines);
  const end = Math.min(lines.length, index + contextLines + 1);

  return {
    lines: lines.slice(start, end),
    errorIndex: index - start,
    errorLine,
    startLine: start + 1,
  };
}

/* ==========================================================================
 * v2 指纹与 culprit（对着 GROUPING_VERSION_SYMBOLICATED）
 * ==========================================================================
 * 与 v1（fingerprint.ts）的区别只有输入：v1 用压缩产物的文件名 / 函数名，
 * 这里用**符号化后的源码路径 / 函数名**。两条纪律：
 *
 *   ① **用完整源码路径，不能只留文件名**：v1 丢目录是因为压缩产物的目录随部署
 *      漂移（本地 / CDN / 预发各不相同），而源码路径 `src/pages/Checkout.tsx`
 *      是稳定的。丢掉目录会让 `pages/Checkout.tsx` 与 `components/Checkout.tsx`
 *      被过度归并成一个问题 —— 而它们显然是两个 bug。
 *
 *   ② **仍然不含行号**：和 v1 同理，任何一次编辑都会平移行号，拼进签名就是
 *      每次提交换一批指纹。FR-4.1 说的"归一化行号"在这里的做法就是"不参与"。
 * ========================================================================*/

/**
 * `webpack://` / `../` 这类前缀对源码路径没有意义，剃掉保证跨构建稳定。
 *
 * ⚠️ 为什么必须剥前导 `../`：sourcemap 里的路径是**相对产物目录**写的。
 * 实测 Vite 产物 `dist/assets/index-x.js.map` 里，SDK 的源码记成
 * `../../../../sdk/index.ts` —— 那个层级取决于 outDir 有多深。
 * 一旦把产物目录改了（dist → public/dist），前缀的 `../` 数量就变，
 * 指纹跟着变，同一个 bug 会在两次构建之间裂成两个问题。
 * 剥掉前导 `../` 之后，`sdk/index.ts` 无论产物放在哪一层都算同一个。
 */
function cleanSourcePath(source: string): string {
  return source
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/{2,}/, '') // 协议：webpack:// 、file://
    .replace(/^(?:\.\.?\/)+/, '') // 前导 ../ 或 ./ 的任意重复
    .replace(/^\.?\//, '') // 剩下的前导 ./ 或 /
    .replace(/\/{2,}/g, '/');
}

/**
 * 符号化后的帧签名：`源码路径:函数名`，取前 FRAME_LIMIT 帧。
 *
 * 只取 resolved 的帧 —— 未还原的帧没有源码信息，拿压缩位置当签名会让 v2
 * 混进 v1 的语义（那种情况本来就不该走 v2，调用方用 allResolved 判断）。
 */
export function symbolicatedSignature(frames: SymbolicatedFrame[]): string {
  return frames
    .filter((frame) => frame.resolved && frame.source !== null)
    .slice(0, FRAME_LIMIT)
    .map(
      (frame) =>
        `${cleanSourcePath(frame.source as string)}:${frame.name ?? '?'}`,
    )
    .join(' -> ');
}

/**
 * v2 指纹：sha256(type | 归一化 message | 源码帧签名)。
 *
 * 与 v1 一样用 `|` 分隔三段 —— 理由见 fingerprint.ts 的 computeFingerprint。
 * message 归一化复用同一套规则（normalize.ts），**不要在这里另写一份**：
 * 否则同一句话在两个版本下归出不同的模板，重算时的合并 / 拆分报告会失真。
 */
export function computeSymbolicatedFingerprint(input: {
  type: string;
  message: string;
  frames: SymbolicatedFrame[];
}): string {
  const canonical = [
    input.type,
    normalizeMessage(input.message),
    symbolicatedSignature(input.frames),
  ].join('|');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** error_groups.culprit 是 varchar(500) */
const CULPRIT_LIMIT = 500;

/**
 * 责任位置（v2）：第一个还原成功的帧，形如 `src/pages/OrderList.tsx:OrderList`。
 *
 * 没有还原成功的帧就返回 null —— culprit 可空正是为这类情况准备的，
 * 不要硬塞空串（"没有责任位置"与"责任位置是空"是两件事）。
 */
export function buildSymbolicatedCulprit(
  frames: SymbolicatedFrame[],
): string | null {
  for (const frame of frames) {
    if (!frame.resolved || frame.source === null) continue;
    return truncate(
      `${cleanSourcePath(frame.source)}:${frame.name ?? '?'}`,
      CULPRIT_LIMIT,
    );
  }
  return null;
}

/** 按**码点**截断（同 fingerprint.ts 的 truncate，避免把 emoji 切成半个） */
function truncate(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join('');
}
