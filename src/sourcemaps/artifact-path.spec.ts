import {
  checkArtifactPath,
  MAX_ARTIFACT_PATH_LENGTH,
  stackFrameToArtifactPath,
  type ArtifactPathError,
} from './artifact-path';

/**
 * artifact_path 校验的离线验证。
 *
 * 这套规则有三个使用方（上传侧 / CLI / Worker 查找侧），任何一方漂移都会
 * 表现为"map 传上去了但永远匹配不上"—— 线上极难查，所以规则本身必须有测试盯着。
 */

/** 断言失败时打印出 error 码，便于定位是哪条规则咬到了 */
function expectFail(input: string, expected: ArtifactPathError): void {
  const r = checkArtifactPath(input);
  if (r.ok) {
    throw new Error(`期望拒绝，但通过了: ${JSON.stringify(input)}`);
  }
  if (r.error !== expected) {
    throw new Error(`期望 ${expected}，实际 ${r.error}: ${JSON.stringify(input)}`);
  }
}

describe('checkArtifactPath', () => {
  describe('正常形态', () => {
    it.each([
      '/assets/index-a1b2c3.js',
      '/js/app.min.js',
      '/index.js',
      '/a/b/c/d/e.js',
      // 中文与百分号编码：资源通道的 message 里真的会出现
      '/assets/%E6%B5%8B%E8%AF%95.png',
      '/assets/图片.png',
    ])('接受 %s', (input) => {
      const r = checkArtifactPath(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.path).toBe(input);
    });

    it('前后空格会被 trim 掉（唯一一种"修正"）', () => {
      const r = checkArtifactPath('  /assets/a.js\n');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.path).toBe('/assets/a.js');
    });
  });

  describe('拒绝：形态不对', () => {
    it('空串', () => expectFail('', 'empty'));
    it('纯空格', () => expectFail('   ', 'empty'));

    it('没有前导斜杠', () => expectFail('assets/a.js', 'not_absolute'));

    it('带 origin（整条 URL 传上来了）', () => {
      expectFail('http://127.0.0.1:8017/assets/a.js', 'not_absolute');
      expectFail('https://cdn.example.com/assets/a.js', 'not_absolute');
    });

    it('以斜杠结尾（是指目录不是文件）', () => expectFail('/assets/', 'ends_with_slash'));

    it('连续斜杠', () => expectFail('/assets//a.js', 'double_slash'));

    it('含 .. 段', () => {
      expectFail('/../etc/passwd', 'dot_segment');
      expectFail('/assets/../../etc/passwd', 'dot_segment');
      // 只是名字里带两个点不算，必须是独立的一段
    });

    it('名字里带 .. 但不是 . 段，应当放行', () => {
      const r = checkArtifactPath('/assets/a..b.js');
      expect(r.ok).toBe(true);
    });

    it('反斜杠', () => expectFail('/assets\\a.js', 'backslash'));

    it('带 query 或 fragment', () => {
      expectFail('/assets/a.js?v=2', 'query_or_fragment');
      expectFail('/assets/a.js#x', 'query_or_fragment');
    });

    it('堆栈位置被当成路径传上来', () => {
      expectFail('/assets/a.js:12:34', 'stack_position');
    });

    it('超长（varchar(500) 边界）', () => {
      const base = '/assets/';
      const ok = base + 'a'.repeat(MAX_ARTIFACT_PATH_LENGTH - base.length);
      expect(checkArtifactPath(ok).ok).toBe(true);

      const tooLong = ok + 'a';
      expectFail(tooLong, 'too_long');
    });
  });

  describe('回归：曾经踩过的坑', () => {
    it('resource 通道的失败 URL 若被整条塞进来，应当被拒', () => {
      // 资源加载失败时 SDK 的 message 形如「资源加载失败 <img> https://…」，有人会拿它当路径
      expectFail(
        'https://cdn.example.com/assets/hero-1.png?1791881743485',
        'not_absolute',
      );
    });

    it('路径里带冒号但不是行列号，应当放行', () => {
      // 冒号只在不以 :数字:数字 结尾时才是合法的文件名一部分
      const r = checkArtifactPath('/assets/a:b.js');
      expect(r.ok).toBe(true);
    });
  });
});

describe('stackFrameToArtifactPath（第三个使用方：Worker 符号化）', () => {
  describe('能归一化的形态', () => {
    it.each([
      // 生产：带 origin + 目录
      ['https://app.example.com/assets/index-B3obYmGb.js', '/assets/index-B3obYmGb.js'],
      // 本地 dev server：端口属于 origin，要一起剥掉
      ['http://127.0.0.1:8017/src/main.js', '/src/main.js'],
      // 部署在子路径（Vite 的 base: '/app/'）
      ['https://cdn.example.com/app/assets/a.js', '/app/assets/a.js'],
      // 带 query：版本参数不属于文件身份
      ['https://cdn.example.com/app/assets/a.js?v=8f2a', '/app/assets/a.js'],
      // 已经是 pathname
      ['/assets/index.js', '/assets/index.js'],
      // 相对路径补前导斜杠
      ['assets/index.js', '/assets/index.js'],
      // webpack 的伪协议
      ['webpack:///src/main.js', '/src/main.js'],
      // 未被上游切干净的行列号
      ['/assets/index.js:10:5', '/assets/index.js'],
      ['https://h/assets/a.js?v=1:48213:5', '/assets/a.js'],
    ])('%s → %s', (input, expected) => {
      expect(stackFrameToArtifactPath(input)).toBe(expected);
    });
  });

  describe('返回 null 的形态', () => {
    it.each([
      ['空串', ''],
      ['纯空格', '   '],
      ['匿名帧', '<anonymous>'],
      ['native', 'native'],
      ['unknown location', 'unknown location'],
    ])('%s', (_label, input) => {
      expect(stackFrameToArtifactPath(input)).toBeNull();
    });

    it('非字符串也不炸（栈是外部输入，运行时没有类型）', () => {
      expect(stackFrameToArtifactPath(undefined as unknown as string)).toBeNull();
      expect(stackFrameToArtifactPath(null as unknown as string)).toBeNull();
    });
  });

  it('产出的路径永远能通过 checkArtifactPath —— 三个使用方共用一套规则', () => {
    const inputs = [
      'https://app.example.com/assets/index-B3obYmGb.js',
      'http://127.0.0.1:8017/src/main.js',
      'webpack:///src/main.js',
      'assets/index.js',
      '/assets/a.js:10:5',
    ];
    for (const input of inputs) {
      const path = stackFrameToArtifactPath(input);
      expect(path).not.toBeNull();
      // 上传侧会拒绝的形态，Worker 也不该算出来
      expect(checkArtifactPath(path as string).ok).toBe(true);
    }
  });

  it('与 CLI 存下来的形态逐字节一致（M3 最关键的契约）', () => {
    // CLI 的 paths.ts 把 dist/assets/index-CiM-gKBb.js.map 算成 /assets/index-CiM-gKBb.js；
    // 浏览器堆栈里出现的是同名文件但带 origin 和行列号 —— 两边必须收敛成同一个字符串，
    // 否则表现是"map 传上去了却永远匹配不上"，而且不报错
    expect(
      stackFrameToArtifactPath('https://app.example.com/assets/index-CiM-gKBb.js:1:48213'),
    ).toBe('/assets/index-CiM-gKBb.js');
  });
});
