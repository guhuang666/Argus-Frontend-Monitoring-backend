import {
  buildCulprit,
  buildTitle,
  computeFingerprint,
  frameSignature,
  GROUPING_VERSION,
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

describe('GROUPING_VERSION', () => {
  it('与 error_groups.grouping_version 的约定一致', () => {
    expect(GROUPING_VERSION).toBe('v1-raw');
  });
});

describe('parseFrames', () => {
  it('吃下三种行形，丢掉首行与锚不住的行', () => {
    expect(parseFrames(REAL_STACK)).toEqual([
      { file: 'http://127.0.0.1:8017/src/main.js', fn: null },
      { file: 'http://127.0.0.1:8017/src/main.js', fn: 'HTMLBodyElement.handler' },
      { file: 'http://127.0.0.1:8017/src/api.js', fn: 'loadData' },
      // `at async http://…` 的 async 会粘在 file 上，必须摘掉
      { file: 'http://127.0.0.1:8017/src/main.js', fn: null },
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
    });
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
  it('只用文件名与函数名，忽略行号', () => {
    const a = parseFrames('Error: x\n    at render (http://h/a.js:10:5)');
    const b = parseFrames('Error: x\n    at render (http://h/a.js:999:1)');
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
    expect(frameSignature(parseFrames(stack))).toBe('1.js:a -> 2.js:b -> 3.js:c');
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
    const fp = computeFingerprint({ type: 'TypeError', message: 'boom', stack: null });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('纯函数：同输入必同输出', () => {
    const input = { type: 'TypeError', message: 'boom 12345', stack: REAL_STACK };
    expect(computeFingerprint(input)).toBe(computeFingerprint(input));
  });

  it('同一个 bug：本地 / 预发 / 生产 → 同一个指纹', () => {
    const message = "Cannot read properties of undefined (reading 'id')";
    const local = computeFingerprint({
      type: 'TypeError',
      message,
      stack: 'TypeError: x\n    at render (http://127.0.0.1:8017/assets/index-a1b2c3.js:10:5)',
    });
    const prod = computeFingerprint({
      type: 'TypeError',
      message,
      stack: 'TypeError: x\n    at render (https://shop.example.com/static/index-9f8e7d.js:88:1)',
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
      message: '资源加载失败 <img> https://cdn.example.com/assets/hero.png?1791881743485',
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
      message: '资源加载失败 <img> https://cdn.example.com/assets/hero-1.png?1791881743485',
      stack: '',
    });
    const b = computeFingerprint({
      type: 'img',
      message: '资源加载失败 <img> https://cdn.example.com/assets/other-2.webp?1791881743486',
      stack: '',
    });
    expect(b).toBe(a);
  });
});

describe('buildTitle', () => {
  it('用归一化后的 message', () => {
    expect(
      buildTitle(
        'TypeError',
        "Cannot read properties of undefined (reading 'id') at http://localhost:5173/a.js",
      ),
    ).toBe('TypeError: Cannot read properties of undefined (reading <string>) at <url>');
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
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title)).toBe(
      false,
    );
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
    const frames = parseFrames('Error: x\n    at http://127.0.0.1:8017/src/main.js:348:13');
    expect(buildCulprit(frames)).toBe('main.js:?');
  });

  it('没有帧就返回 null —— culprit 可空正是为 resource 通道准备的', () => {
    expect(buildCulprit(parseFrames(''))).toBeNull();
    expect(buildCulprit(parseFrames('Error: x\n    at <anonymous>:1:1'))).toBeNull();
  });
});
