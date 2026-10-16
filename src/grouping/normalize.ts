/**
 * 消息归一化 —— 指纹算法的第一道工序（M2 / 对应 SRS FR-4.2）。
 *
 * 目的：把「每次都变」的片段（UUID、URL、十六进制串、长数字、字符串字面量）
 * 换成固定占位符，让同一个 bug 的多次发生归一化成**同一个字符串**，
 * 进而算出同一个指纹、归并成同一个问题。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────
 * ① 入参必须是**原始** message。归一化只发生在「算指纹」这一步，绝不能把结果
 *    回写覆盖 error_events.message —— TC-10 要求指纹的输入能从原始载荷无损重建。
 * ② 规则顺序即优先级，不能重排。顺序错了有两类后果：
 *      · 大颗粒没先替换 → 被小颗粒切碎（UUID 会先被数字规则切成
 *        <number>e<number>-<number>…，UUID 规则再也匹配不上）
 *      · 占位符被后续规则二次替换（本表所有占位符都不含数字/URL/引号，天然免疫）
 * ③ 纯函数：同输入必同输出。不许出现时间、随机数、环境相关的分支 ——
 *    指纹抖一次，看板上就多一个假问题。
 *
 * ── 与 SDK 的耦合点（改 SDK 消息格式必须同步这里）───────────────────────
 * 资源通道（resource）**没有堆栈**，SDK 发的 stack 是空串，指纹只能靠 type + message。
 * 而 message 里带着失败的资源 URL，每张图都不同 —— 不归一化就是
 * 「1000 条上报 → 几百个问题」。格式见 sdk/index.ts 的 buildResource()：
 *
 *     资源加载失败 <img> https://cdn.example.com/assets/hero-1.png?1791881743485
 *     ↓ 归一化
 *     资源加载失败 <img> <asset>
 *
 * 注意 type 字段本身是标签名（img / script / link），所以「图片加载失败」和
 * 「脚本加载失败」仍然分属两个问题 —— 这是有意的，两者根因和修法完全不同。
 */

/** 一条归一化规则。pattern 只用于 replace，不要拿去 test/exec。 */
interface NormalizeRule {
  /** 规则名。测试失败时用它定位是哪条规则咬到了 */
  readonly name: string;
  /**
   * 匹配模式。必须带 g 标志（要替换全部出现）。
   * 提示：带 g 的正则对象有 lastIndex 状态，用 test()/exec() 复用会踩坑；
   * 本文件只用 replace()，它每次都会重置，安全。
   */
  readonly pattern: RegExp;
  /** 替换成的占位符；需要保留捕获组时用 $1 */
  readonly to: string;
}

/**
 * 归一化规则表：**数组顺序就是执行顺序**，改动前先读文件头的「三条纪律」。
 */
export const RULES: readonly NormalizeRule[] = [
  // ① UUID —— 必须最先。
  //    一个 UUID 里同时有十六进制段和数字段，先跑 hex/number 规则会把它切碎。
  {
    name: 'uuid',
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    to: '<uuid>',
  },
  // ② 资源通道的 URL —— 必须排在通用 URL 规则**前面**，否则先被吃掉变成 <url>，
  //    「资源加载失败 → <asset>」这条语义就丢了。
  //    用后行断言锚住 SDK 的消息形状：好处是函数保持纯粹（不需要知道 mechanism）；
  //    代价是 SDK 一旦改消息格式，这条正则要跟着改（已在上方「耦合点」标注）。
  //    \s{0,4} 是给「标签和 URL 之间可能有空格」留的余量；没有 URL 时不匹配，原样保留。
  {
    name: 'asset',
    pattern: /(?<=资源加载失败\s{0,4}<[a-z]+>\s{0,4})\S+/g,
    to: '<asset>',
  },
  // ③ 绝对 URL（含 query 和 fragment）—— 必须排在 hex/number 前，
  //    否则 URL 里的十六进制段和数字会先被替换，整条路径就认不出来了
  {
    name: 'url-absolute',
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi,
    to: '<url>',
  },
  // ④ 相对路径 —— SRS §5.4 的例子 `Timeout after 3000ms at /api/a?t=17` 就是这种。
  //    $1 把前面的分隔符原样还回去（不然会吃掉一个空格，把词粘在一起）。
  //    已知简化：只认「行首 / 空白 / 括号引号等号」开头的路径；紧跟中文的路径不匹配。
  {
    name: 'url-relative',
    pattern: /(^|[\s("'=])\/[^\s"'<>)]+/g,
    to: '$1<url>',
  },
  // ⑤ 十六进制串（≥8 位）—— 必须排在 number 前，否则 a1b2c3d4 会被切成 a<number>b<number>…
  //    注意：纯数字的长串也是合法十六进制，所以 13 位时间戳会落到这里变成 <hex>。
  //    对归并没有影响（同样稳定），只是名字看着奇怪；想让它归 <number>，
  //    在 {8,} 前面加一个 (?=[0-9a-f]*[a-f]) 即可（要求至少含一个字母）
  {
    name: 'hex',
    pattern: /(?<![0-9a-z])[0-9a-f]{8,}(?![0-9a-z])/gi,
    to: '<hex>',
  },
  // ⑥ 长数字（≥4 位）—— 门槛取 4 而不是 1，因为 1~3 位数（版本号、端口、短 ID）
  //    在正常文本里太常见，一律替换会把消息糊成一片，反而降级归并质量。
  //    用否定环视做边界而不用 \b：\b 是 ASCII 词边界，中文（`用户10231`）旁边行为反直觉。
  //    只做**前**边界、不做后边界：单位后缀紧跟数字是合法写法（`3000ms` / `200px`），
  //    加了后视会把它们整条挡掉，SRS 的 `Timeout after 3000ms` 用例就过不了；
  //    而「别匹配半个数字」这件事由 {4,} 的贪婪匹配自己保证（12345 会整体吃掉）
  {
    name: 'number',
    pattern: /(?<![0-9a-z])[0-9]{4,}/g,
    to: '<number>',
  },
  // ⑦ 引号包裹的内容（字符串字面量）—— 放最后：里面的 URL / 数字已经被前面的规则
  //    处理过，反正整段都会被吞掉，顺序只影响中间态，不影响最终结果
  {
    name: 'string',
    pattern: /"[^"]*"|'[^']*'/g,
    to: '<string>',
  },
];

/**
 * 归一化一条消息。
 *
 * @param raw 原始 message（**不要**传已经归一化过的值，见文件头纪律 ①）
 * @returns 归一化后的字符串；null / undefined 视为空串
 */
export function normalizeMessage(raw: string | null | undefined): string {
  let out = typeof raw === 'string' ? raw : '';
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.to);
  }
  return out;
}
