import { TraceMap } from '@jridgewell/trace-mapping';
import type { EncodedSourceMap } from '@jridgewell/trace-mapping';
import { computeFingerprint } from './fingerprint';
import type { Frame } from './fingerprint';
import {
  buildSymbolicatedCulprit,
  computeSymbolicatedFingerprint,
  symbolicateFrames,
  symbolicatedSignature,
} from './symbolicate';
import type { SourcemapResolver, SymbolicatedFrame } from './symbolicate';

/**
 * Symbolmap 符号化的离线验证（M3 / S4）。
 *
 * ── 为什么要手工造一个 map，而不是读真实文件 ─────────────────────────────
 * 真实的 .map 有几十万个映射段，断言只能写"看起来对"。手写的小 map 让每个
 * 断言都能精确到"第几行第几列"，尤其是**列号 0-based 与 1-based 的换算** ——
 * 那是这套代码最容易错、也最难被真实数据发现的一处（错一格照样"看起来对"）。
 *
 * ── 这个 map 的结构 ─────────────────────────────────────────────────────
 *   mappings = "AAAAA,UACAA"        生成第 1 行有两个段
 *
 *   段 0：生成列 0   → 源码 src/pages/OrderList.tsx 第 1 行第 1 列，名字 OrderList
 *   段 1：生成列 10  → 源码第 2 行第 1 列，名字沿用上一个（delta 0）
 *
 *   两者之间是"继承上一个段"的区间：查列 0~9 都落第 1 行，查列 10 起落第 2 行。
 *   这正是用来验证 `column: col - 1` 的杠杆（见下面那条关键用例）。
 */

/** 10 行源码，每行带自己的行号，便于断言上下文切得对不对 */
const TSX_LINES = Array.from({ length: 10 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return `L${n} // 源码第 ${i + 1} 行`;
});

const MAP_JSON: EncodedSourceMap = {
  version: 3,
  file: 'order-list.js',
  sources: ['src/pages/OrderList.tsx'],
  sourcesContent: [TSX_LINES.join('\n')],
  names: ['OrderList'],
  mappings: 'AAAAA,UACAA',
};

/** 同一张 map，但抹掉内嵌源码 —— 验证"能定位但看不到代码"的降级 */
const MAP_WITHOUT_CONTENT: EncodedSourceMap = {
  version: 3,
  file: 'order-list.js',
  sources: ['src/pages/OrderList.tsx'],
  names: ['OrderList'],
  mappings: 'AAAAA,UACAA',
};

const ARTIFACT = '/assets/order-list.js';

/** 只认 /assets/order-list.js 的查表函数 */
function resolverFor(map: EncodedSourceMap): SourcemapResolver {
  return (artifactPath) =>
    artifactPath === ARTIFACT ? new TraceMap(map) : null;
}

/** 造一帧压缩后的位置；file 用真实形状（带 origin 的完整 URL） */
function frameAt(col: number, line = 1): Frame {
  return {
    file: 'https://app.example.com/assets/order-list.js',
    fn: 'r',
    line,
    col,
  };
}

describe('symbolicateFrames', () => {
  it('命中：还原出源码文件、行号、列号与原始函数名', () => {
    const r = symbolicateFrames([frameAt(11)], resolverFor(MAP_JSON));

    expect(r.resolvedCount).toBe(1);
    expect(r.withFileCount).toBe(1);
    expect(r.allResolved).toBe(true);

    const f = r.frames[0];
    // 压缩位置原样保留（看板要把两边并排展示）
    expect(f.artifactPath).toBe(ARTIFACT);
    expect(f.line).toBe(1);
    expect(f.col).toBe(11);
    // 源码位置
    expect(f.resolved).toBe(true);
    expect(f.source).toBe('src/pages/OrderList.tsx');
    expect(f.sourceLine).toBe(2);
    expect(f.sourceCol).toBe(1);
    expect(f.name).toBe('OrderList');
  });

  it('列号 1-based → 0-based：col=10 落第 1 行，col=11 才落第 2 行', () => {
    // 段 1 位于生成列 10（0-based）。查询 1-based 的 col=10 时，
    // 正确做法是先减 1 得到 9，仍落在段 0（第 1 行）；
    // 若忘了减 1，会用 10 直接命中段 1，还原成第 2 行 —— 位置整体右移一格。
    const atTen = symbolicateFrames([frameAt(10)], resolverFor(MAP_JSON));
    const atEleven = symbolicateFrames([frameAt(11)], resolverFor(MAP_JSON));

    expect(atTen.frames[0].sourceLine).toBe(1);
    expect(atEleven.frames[0].sourceLine).toBe(2);
  });

  it('源码上下文：出错行前后各 5 行，并给出出错行下标', () => {
    const r = symbolicateFrames([frameAt(11)], resolverFor(MAP_JSON));
    const ctx = r.frames[0].context;

    expect(ctx).not.toBeNull();
    if (ctx === null) return;

    // 第 2 行前面只有 1 行，后面还有 8 行 → 取 [0, 7) 共 7 行
    expect(ctx.lines).toHaveLength(7);
    expect(ctx.lines[0]).toBe(TSX_LINES[0]);
    expect(ctx.lines[1]).toBe(TSX_LINES[1]);
    expect(ctx.errorIndex).toBe(1);
    expect(ctx.errorLine).toBe(2);
    expect(ctx.startLine).toBe(1);
  });

  it('contextLines 可调：0 表示只要出错行本身', () => {
    const r = symbolicateFrames([frameAt(11)], resolverFor(MAP_JSON), {
      contextLines: 0,
    });
    const ctx = r.frames[0].context;

    expect(ctx?.lines).toHaveLength(1);
    expect(ctx?.lines[0]).toBe(TSX_LINES[1]);
    expect(ctx?.errorIndex).toBe(0);
    expect(ctx?.startLine).toBe(2);
  });

  it('map 没内嵌源码：能定位，但 context 为 null（不是失败）', () => {
    const r = symbolicateFrames(
      [frameAt(11)],
      resolverFor(MAP_WITHOUT_CONTENT),
    );
    const f = r.frames[0];

    expect(f.resolved).toBe(true);
    expect(f.source).toBe('src/pages/OrderList.tsx');
    expect(f.sourceLine).toBe(2);
    expect(f.context).toBeNull();
  });

  it('map 里没有这一行：不猜，resolved=false 且原始位置还在', () => {
    // 这张 map 只有生成第 1 行
    const r = symbolicateFrames([frameAt(11, 5)], resolverFor(MAP_JSON));
    const f = r.frames[0];

    expect(f.resolved).toBe(false);
    expect(f.source).toBeNull();
    // 降级展示要靠这些字段（FR-3.9：未符号化时仍要能读到压缩位置）
    expect(f.file).toBe('https://app.example.com/assets/order-list.js');
    expect(f.line).toBe(5);
  });

  it('找不到对应的 map：整帧保持未还原', () => {
    const r = symbolicateFrames([frameAt(11)], () => null);

    expect(r.resolvedCount).toBe(0);
    expect(r.withFileCount).toBe(1);
    expect(r.allResolved).toBe(false);
    expect(r.frames[0].artifactPath).toBe(ARTIFACT);
    expect(r.frames[0].resolved).toBe(false);
  });

  it('伪文件（<anonymous>）不计入分母', () => {
    const r = symbolicateFrames(
      [{ file: '<anonymous>', fn: null, line: 1, col: 1 }],
      resolverFor(MAP_JSON),
    );

    expect(r.frames[0].artifactPath).toBeNull();
    expect(r.withFileCount).toBe(0);
    expect(r.resolvedCount).toBe(0);
    // 没有可还原的东西 → 上层应当继续走 v1 指纹
    expect(r.allResolved).toBe(false);
  });

  it('空帧数组（resource 通道）：allResolved=false，不抛错', () => {
    const r = symbolicateFrames([], resolverFor(MAP_JSON));

    expect(r.frames).toEqual([]);
    expect(r.withFileCount).toBe(0);
    expect(r.allResolved).toBe(false);
  });

  it('混合帧：一帧命中 + 一帧伪文件 → 命中那帧决定 allResolved', () => {
    const r = symbolicateFrames(
      [frameAt(11), { file: '<anonymous>', fn: null, line: 1, col: 1 }],
      resolverFor(MAP_JSON),
    );

    expect(r.withFileCount).toBe(1);
    expect(r.resolvedCount).toBe(1);
    expect(r.allResolved).toBe(true);
    expect(r.frames).toHaveLength(2);
  });

  it('列号 0 不会算出负数（防御 Math.max）', () => {
    // V8 不会给 0，但栈是外部输入，第三方的畸形堆栈可能
    const r = symbolicateFrames([frameAt(0)], resolverFor(MAP_JSON));
    expect(r.frames[0].resolved).toBe(true);
    expect(r.frames[0].sourceLine).toBe(1);
  });
});

/** 手造一帧还原结果，用于单独验证签名 / culprit 的规则 */
function symFrame(
  overrides: Partial<SymbolicatedFrame> = {},
): SymbolicatedFrame {
  return {
    file: 'https://h/assets/a.js',
    fn: 'r',
    line: 1,
    col: 1,
    artifactPath: '/assets/a.js',
    resolved: true,
    source: 'src/pages/Checkout.tsx',
    sourceLine: 10,
    sourceCol: 1,
    name: 'render',
    context: null,
    ...overrides,
  };
}

describe('符号化后的签名与 v2 指纹', () => {
  it('签名 = 源码路径:源码函数名', () => {
    const frames = symbolicateFrames(
      [frameAt(11)],
      resolverFor(MAP_JSON),
    ).frames;
    expect(symbolicatedSignature(frames)).toBe(
      'src/pages/OrderList.tsx:OrderList',
    );
  });

  it('未还原的帧不进签名（避免 v2 里混进压缩位置）', () => {
    const frames = symbolicateFrames([frameAt(11)], () => null).frames;
    expect(symbolicatedSignature(frames)).toBe('');
  });

  it('行号不参与签名：源码位置相同、压缩列不同 → 同一指纹', () => {
    // 两个压缩列都落在同一个映射段（源码第 1 行）
    const a = computeSymbolicatedFingerprint({
      type: 'TypeError',
      message: 'boom',
      frames: symbolicateFrames([frameAt(1)], resolverFor(MAP_JSON)).frames,
    });
    const b = computeSymbolicatedFingerprint({
      type: 'TypeError',
      message: 'boom',
      frames: symbolicateFrames([frameAt(10)], resolverFor(MAP_JSON)).frames,
    });
    expect(a).toBe(b);
  });

  it('不同目录下的同名文件不会被过度归并（这正是保留完整路径的理由）', () => {
    const pages = symbolicatedSignature([
      symFrame({ source: 'src/pages/Checkout.tsx' }),
    ]);
    const components = symbolicatedSignature([
      symFrame({ source: 'src/components/Checkout.tsx' }),
    ]);

    // 若像 v1 那样只留 basename，这两行会相同 —— 但它们显然是两个不同的 bug
    expect(pages).toBe('src/pages/Checkout.tsx:render');
    expect(components).toBe('src/components/Checkout.tsx:render');
    expect(pages).not.toBe(components);
  });

  it('剃掉 webpack:// 之类的协议前缀，保证跨构建稳定', () => {
    expect(
      symbolicatedSignature([symFrame({ source: 'webpack:///src/a.tsx' })]),
    ).toBe('src/a.tsx:render');
  });

  it('剥掉前导 ../：产物目录变深变浅都不影响指纹', () => {
    // Vite 在 dist/assets 下会把源码记成 ../../src/App.tsx；
    // 换一个更深的 outDir，前缀的 ../ 数量就变 —— 不剥就会换一批指纹
    const shallow = symbolicatedSignature([symFrame({ source: '../../src/App.tsx' })]);
    const deep = symbolicatedSignature([symFrame({ source: '../../../../src/App.tsx' })]);
    const plain = symbolicatedSignature([symFrame({ source: 'src/App.tsx' })]);

    expect(shallow).toBe('src/App.tsx:render');
    expect(deep).toBe('src/App.tsx:render');
    expect(plain).toBe('src/App.tsx:render');
  });

  it('v2 指纹：64 位十六进制，且与 v1 同输入下的结果不同', () => {
    const message = 'Cannot read properties of undefined';
    const stack =
      'TypeError: x\n    at r (https://app.example.com/assets/order-list.js:1:11)';

    const v1 = computeFingerprint({ type: 'TypeError', message, stack });
    const v2 = computeSymbolicatedFingerprint({
      type: 'TypeError',
      message,
      frames: symbolicateFrames([frameAt(11)], resolverFor(MAP_JSON)).frames,
    });

    expect(v2).toMatch(/^[0-9a-f]{64}$/);
    expect(v2).not.toBe(v1);
  });
});

describe('buildSymbolicatedCulprit', () => {
  it('取第一个还原成功的帧', () => {
    expect(
      buildSymbolicatedCulprit([
        symFrame({ resolved: false, source: null }),
        symFrame(),
        symFrame({ source: 'src/other.tsx' }),
      ]),
    ).toBe('src/pages/Checkout.tsx:render');
  });

  it('匿名函数用 ? 占位', () => {
    expect(buildSymbolicatedCulprit([symFrame({ name: null })])).toBe(
      'src/pages/Checkout.tsx:?',
    );
  });

  it('全部未还原 → null（不塞空串）', () => {
    expect(
      buildSymbolicatedCulprit([symFrame({ resolved: false })]),
    ).toBeNull();
    expect(buildSymbolicatedCulprit([])).toBeNull();
  });
});
