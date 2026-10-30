import { symbolicateFrames } from './symbolicate';

/**
 * symbolicateFrames 的最小单测（就 1 条用例）。
 *
 * 跑它：
 *   npx jest --runInBand src/grouping/symbolicate-frames
 *
 * ── 这个函数干什么 ──────────────────────────────────────────────────────
 *   压缩后的帧（index.js:1:348）+ sourcemap  →  源码位置（OrderList.tsx:42）
 * 第二个参数 resolve 是"产物路径 → sourcemap"的查表函数，由调用方给，
 * 所以在测试里可以塞任意假函数，不需要磁盘、不需要数据库。
 */

/** 一帧压缩后的位置：浏览器会说"出在 index.js 第 1 行第 1 列" */
const ONE_FRAME = [
  {
    file: 'https://app.example.com/assets/index.js',
    fn: 'r',
    line: 1,
    col: 1,
  },
];

describe('symbolicateFrames', () => {
  it('查不到 sourcemap 时：不抛错，原样保留压缩位置', () => {
    // resolve 永远返回 null = "这个项目从来没上传过 map"
    const result = symbolicateFrames(ONE_FRAME, () => null);

    const [frame] = result.frames;

    // ① 没还原，但也没抛错 —— 符号化是锦上添花，不能拖垮归并
    expect(frame.resolved).toBe(false);
    expect(frame.source).toBeNull();

    // ② 压缩位置原样保留：界面上要能显示"出在哪个文件的哪一行"
    expect(frame.file).toBe('https://app.example.com/assets/index.js');
    expect(frame.artifactPath).toBe('/assets/index.js');

    // ③ 计数口径：这一帧"有文件"，只是没还原成功。
    //    分母是 1 而不是 0 —— 这个区别决定了 allResolved 的语义
    expect(result.withFileCount).toBe(1);
    expect(result.resolvedCount).toBe(0);
    expect(result.allResolved).toBe(false);
  });
});
