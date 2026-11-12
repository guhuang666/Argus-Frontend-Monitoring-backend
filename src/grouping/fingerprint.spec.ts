import {
  buildCulprit,
  buildTitle,
  computeFingerprint,
  frameSignature,
  GROUPING_VERSION_RAW,
  GROUPING_VERSION_SYMBOLICATED,
  parseFrames,
  stripFileHash,
} from './fingerprint';

/** 一段真实形状的栈：匿名帧 / 具名帧 / async 帧 / Promise.all 噪声行各一条 */
const REAL_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  '    at http://127.0.0.1:8017/src/main.js:348:13',
  '    at HTMLBodyElement.handler (http://127.0.0.1:8017/src/main.js:355:13)',
  '    at async loadData (http://127.0.0.1:8017/src/api.js:12:5)',
  '    at async http://127.0.0.1:8017/src/main.js:400:1',
  '    at async Promise.all (index 0)',
].join('\n');

describe('分组版本常量', () => {
  it('v1 = 压缩位置，v2 = 符号化后，且两者不同（同指纹可并存，FR-4.12）', () => {
    expect(GROUPING_VERSION_RAW).toBe('v1-raw');
    expect(GROUPING_VERSION_SYMBOLICATED).toBe('v2-symbolicated');
    expect(GROUPING_VERSION_RAW).not.toBe(GROUPING_VERSION_SYMBOLICATED);
  });
});

describe('parseFrames', () => {
  it('吃下三种行形，丢掉首行与锚不住的行', () => {
    expect(parseFrames(REAL_STACK)).toEqual([
      {
        file: 'http://127.0.0.1:8017/src/main.js',
        fn: null,
        line: 348,
        col: 13,
      },
      {
        file: 'http://127.0.0.1:8017/src/main.js',
        fn: 'HTMLBodyElement.handler',
        line: 355,
        col: 13,
      },
      {
        file: 'http://127.0.0.1:8017/src/api.js',
        fn: 'loadData',
        line: 12,
        col: 5,
      },
      // `at async http://…` 的 async 会粘在 file 上，必须摘掉
      {
        file: 'http://127.0.0.1:8017/src/main.js',
        fn: null,
        line: 400,
        col: 1,
      },
      // `at async Promise.all (index 0)` 没有文件与行列 → 丢弃
    ]);
  });

  it('URL 自带冒号也不会切错行列号', () => {
    const [frame] = parseFrames(
      'Error: x\n    at Object.<anonymous> (https://shop.example.com:8443/js/app.js?v=8f2a:10:5)',
    );
    expect(frame).toEqual({
      file: 'https://shop.example.com:8443/js/app.js?v=8f2a',
      fn: 'Object.<anonymous>',
      line: 10,
      col: 5,
    });
  });

  it('M3：行列号按浏览器报的 1-based 原样保留，不做 0-based 转换', () => {
    // 转换发生在符号化查表那一刻（col - 1），不在解析阶段 —— 否则这个字段
    // 的基准会变得含糊，以后没人说得清它到底是哪套
    const [frame] = parseFrames(
      'Error: x\n    at render (http://h/a.js:1:48213)',
    );
    expect(frame.line).toBe(1);
    expect(frame.col).toBe(48213);
  });

  it('没有栈就是空数组（resource 通道）', () => {
    expect(parseFrames('')).toEqual([]);
    expect(parseFrames(null)).toEqual([]);
    expect(parseFrames(undefined)).toEqual([]);
  });
});

describe('stripFileHash', () => {
  it.each([
    ['index-a1b2c3.js', 'index.js'],
    ['checkout.9f2c.js', 'checkout.js'],
    // 拍板 ②：夹在中间的 hash 剥掉，`.chunk.js` 标记保留
    ['main.a1b2c3d4.chunk.js', 'main.chunk.js'],
    ['main.a1b2c3d4.chunk.9f2c.js', 'main.chunk.js'],
    ['vendor~main.9f2c.js', 'vendor~main.js'],
    ['bundle.A1B2C3D4.js', 'bundle.js'],
    ['styles.9f2c.css', 'styles.css'],
    // dir 保留（origin 的剥离发生在 frameFile，不在这里）
    ['/assets/index-a1b2c3.js', '/assets/index.js'],
    // min / chunk / umd 不是纯十六进制，天然免疫
    ['main.min.js', 'main.min.js'],
    ['jquery-3.7.1.min.js', 'jquery-3.7.1.min.js'],
    // 护栏：主名整体是 hex 时绝不剥空（1234 是 webpack 的 chunk id）
    ['1234.js', '1234.js'],
    ['a1b2c3.js', 'a1b2c3.js'],
    ['app.js', 'app.js'],
  ])('%s → %s', (input, expected) => {
    expect(stripFileHash(input)).toBe(expected);
  });
});

describe('frameSignature', () => {
  it('只用文件名与函数名，忽略行号（M3：行列号保留但不参与）', () => {
    const a = parseFrames('Error: x\n    at render (http://h/a.js:10:5)');
    const b = parseFrames('Error: x\n    at render (http://h/a.js:999:1)');
    // 前提断言：两个 Frame 的行列号**确实不同** —— 否则下面的相等性什么都没证明
    expect(a[0].line).toBe(10);
    expect(a[0].col).toBe(5);
    expect(b[0].line).toBe(999);
    expect(b[0].col).toBe(1);
    expect(frameSignature(a)).toBe('a.js:render');
    expect(frameSignature(b)).toBe('a.js:render');
  });

  it('换 origin / 端口 / 目录 / hash 都不改签名（拍板 ③）', () => {
    const local = parseFrames(
      'Error: x\n    at render (http://127.0.0.1:8017/assets/index-a1b2c3.js:10:5)',
    );
    const prod = parseFrames(
      'Error: x\n    at render (https://shop.example.com/static/js/index-9f8e7d.js:10:5)',
    );
    expect(frameSignature(local)).toBe('index.js:render');
    expect(frameSignature(prod)).toBe('index.js:render');
  });

  it('最多取前 3 帧，第 4 帧起不影响签名', () => {
    const stack = [
      'Error: x',
      '    at a (http://h/1.js:1:1)',
      '    at b (http://h/2.js:1:1)',
      '    at c (http://h/3.js:1:1)',
      '    at d (http://h/4.js:1:1)',
    ].join('\n');
    expect(frameSignature(parseFrames(stack))).toBe(
      '1.js:a -> 2.js:b -> 3.js:c',
    );
  });

  it('伪文件不算帧，无名帧用 ? 占位', () => {
    const frames = parseFrames(
      'Error: x\n    at <anonymous>:1:1\n    at http://h/main.js:2:2',
    );
    expect(frameSignature(frames)).toBe('main.js:?');
  });

  it('无帧时是空串（resource 通道）', () => {
    expect(frameSignature([])).toBe('');
  });
});

describe('computeFingerprint', () => {
  it('输出 64 位十六进制，正好塞满 varchar(64)', () => {
    const fp = computeFingerprint({
      type: 'TypeError',
      message: 'boom',
      stack: null,
    });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('纯函数：同输入必同输出', () => {
    const input = {
      type: 'TypeError',
      message: 'boom 12345',
      stack: REAL_STACK,
    };
    expect(computeFingerprint(input)).toBe(computeFingerprint(input));
  });

  it('同一个 bug：本地 / 预发 / 生产 → 同一个指纹', () => {
    const message = "Cannot read properties of undefined (reading 'id')";
    const local = computeFingerprint({
      type: 'TypeError',
      message,
      stack:
        'TypeError: x\n    at render (http://127.0.0.1:8017/assets/index-a1b2c3.js:10:5)',
    });
    const prod = computeFingerprint({
      type: 'TypeError',
      message,
      stack:
        'TypeError: x\n    at render (https://shop.example.com/static/index-9f8e7d.js:88:1)',
    });
    expect(prod).toBe(local);
  });

  it('message 里的 UUID / URL / 时间戳不影响指纹', () => {
    const a = computeFingerprint({
      type: 'Error',
      message: 'Failed order 550e8400-e29b-41d4-a716-446655440000 at /api/o/9',
      stack: null,
    });
    const b = computeFingerprint({
      type: 'Error',
      message: 'Failed order 7c9e6679-7425-40de-944b-e07fc1f90ae7 at /api/o/9',
      stack: null,
    });
    expect(b).toBe(a);
  });

  it('type 不同就是不同的问题（图片失败 ≠ 脚本失败）', () => {
    const img = computeFingerprint({
      type: 'img',
      message:
        '资源加载失败 <img> https://cdn.example.com/assets/hero.png?1791881743485',
      stack: '',
    });
    const script = computeFingerprint({
      type: 'script',
      message: '资源加载失败 <script> https://cdn.example.com/v2/app.js',
      stack: '',
    });
    expect(script).not.toBe(img);
  });

  it('resource 通道：一万张图失败归一成一个指纹', () => {
    const a = computeFingerprint({
      type: 'img',
      message:
        '资源加载失败 <img> https://cdn.example.com/assets/hero-1.png?1791881743485',
      stack: '',
    });
    const b = computeFingerprint({
      type: 'img',
      message:
        '资源加载失败 <img> https://cdn.example.com/assets/other-2.webp?1791881743486',
      stack: '',
    });
    expect(b).toBe(a);
  });
});

/**
 * 指纹黄金基线 —— M3 加 line / col 之前测出来的真实值。
 *
 * 这三条是"历史数据没被破坏"的**唯一硬证据**：只要它们没变，就说明
 * M2 归并出的所有 error_groups 仍然对得上新算出来的指纹。
 *
 * ⚠️ 改 normalize.ts 的规则、或让 line / col 进入 frameSignature，
 * 都会让它们变红 —— 那时候**不要"更新期望值"**，先想清楚是不是真的要 bump
 * GROUPING_VERSION（见 fingerprint.ts 里那条规矩）。
 */
describe('指纹基线（M3 之前测出的值，不得变化）', () => {
  it('A：TypeError + 单帧栈', () => {
    expect(
      computeFingerprint({
        type: 'TypeError',
        message: "Cannot read properties of undefined (reading 'total')",
        stack:
          "TypeError: Cannot read properties of undefined (reading 'total')\n" +
          '    at OrderList (https://app.example.com/assets/index-B3obYmGb.js:1:48213)',
      }),
    ).toBe('ff27ad4bf45dbcd244f4f9e641fbcb23083be8839029202a7ac34bb76f131b60');
  });

  it('B：Error + 三帧栈', () => {
    expect(
      computeFingerprint({
        type: 'Error',
        message: 'Timeout after 3000ms at /api/a?t=17',
        stack:
          'Error: Timeout after 3000ms at /api/a?t=17\n' +
          '    at load (https://app.example.com/assets/index-a1b2c3.js:1:100)\n' +
          '    at useEffect (https://app.example.com/assets/vendor-9f8e7d.js:1:200)',
      }),
    ).toBe('29e5a587f0c8520036b988bd3457c7a30e64410b9e5df1fee978bc767321c39d');
  });

  it('C：resource 通道（无栈）', () => {
    expect(
      computeFingerprint({
        type: 'img',
        message: 'resource load failed <img> https://cdn.example.com/a.png',
        stack: '',
      }),
    ).toBe('22f97752dc201dc8b05555fb6e00736efa3a9357f8e856022849ea3e1142edfd');
  });
});

describe('buildTitle', () => {
  it('用归一化后的 message', () => {
    expect(
      buildTitle(
        'TypeError',
        "Cannot read properties of undefined (reading 'id') at http://localhost:5173/a.js",
      ),
    ).toBe(
      'TypeError: Cannot read properties of undefined (reading <string>) at <url>',
    );
  });

  it('截到 500 个字符（中文按 1 个算）', () => {
    const title = buildTitle('Error', '中'.repeat(600));
    expect(Array.from(title)).toHaveLength(500);
    expect(title.endsWith('中')).toBe(true);
  });

  it('emoji 不会被切成半个代理对', () => {
    const title = buildTitle('Error', '😀'.repeat(600));
    expect(Array.from(title)).toHaveLength(500);
    // 单独的高/低代理 = 半个字符，落库时是非法 UTF-8
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        title,
      ),
    ).toBe(false);
  });
});

describe('buildCulprit', () => {
  it('取第一个有文件的帧，文件名与指纹同源（剥 origin / hash）', () => {
    const frames = parseFrames(
      'Error: x\n    at render (https://shop.example.com/assets/index-a1b2c3.js:10:5)',
    );
    expect(buildCulprit(frames)).toBe('index.js:render');
  });

  it('匿名帧用 ? 补函数名', () => {
    const frames = parseFrames(
      'Error: x\n    at http://127.0.0.1:8017/src/main.js:348:13',
    );
    expect(buildCulprit(frames)).toBe('main.js:?');
  });

  it('没有帧就返回 null —— culprit 可空正是为 resource 通道准备的', () => {
    expect(buildCulprit(parseFrames(''))).toBeNull();
    expect(
      buildCulprit(parseFrames('Error: x\n    at <anonymous>:1:1')),
    ).toBeNull();
  });
});
