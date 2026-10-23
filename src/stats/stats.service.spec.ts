import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { StatsService } from './stats.service';

/**
 * jest 加载不了 generated/prisma/client.ts —— 它是 prisma-client 生成器产出的
 * TS 源码，内部用 `./internal/class.js` 这种"指向 .ts 源文件"的写法，
 * jest 的解析器不认（同 error-events.service.spec.ts 里那段说明）。
 *
 * 所以整个模块用工厂替换掉。这里只需要 `Prisma.raw`：
 *   · PrismaClient 必须存在 —— prisma.service.ts 里是 `class PrismaService
 *     extends PrismaClient`，缺了它加载 PrismaService 时就
 *     "Class extends value undefined"
 *   · raw 的真实返回值带一个 `sql` getter，这里保留同名字段，
 *     测试才能从语句里读到最终用的列名（否则只能看到一个 [object Object]，
 *     "metric 会不会被拼进 SQL" 这件事就完全测不到了）
 *
 * PrismaService 只能 `import type`：类型引用编译后被擦除，
 * 一旦当成值引入，真实的 generated 模块又会被拉进来。
 */
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {
    raw: (value: string) => ({ sql: value, strings: [value], values: [] }),
  },
}));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const HOUR_MS = 3_600_000;

/**
 * 假 Prisma：按调用顺序回放预置结果，并把每条 SQL 的模板与参数记下来。
 *
 * ── 为什么要记 `strings` 而不只是"返回什么" ─────────────────────────────
 * 这个 service 的正确性有一半在 SQL 里（`IS NOT NULL`、`percentile_cont`、
 * `date_bin`）。这些都写在原生 SQL 里，Prisma 的 mock 不会替我们检查，
 * 所以只能断言"发出去的语句长什么样"——否则单测全绿、线上分位数算错。
 *
 * `$queryRaw` 是 tagged template：第一个参数是字符串数组，后面是插值参数。
 * 插值在真实 Prisma 里会变成 $1/$2 占位符，这里用 '?' 占位拼回去，方便阅读。
 */
interface SqlCall {
  text: string;
  values: unknown[];
}

function fakePrisma(responses: unknown[][]): {
  prisma: unknown;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  let cursor = 0;

  const prisma = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      const rows = responses[cursor] ?? [];
      cursor += 1;
      return Promise.resolve(rows);
    },
    // 真实实现是"同一事务同一快照"，这里只需按顺序把三个 promise 解出来
    $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };

  return { prisma, calls };
}

function build(responses: unknown[][] = []): {
  service: StatsService;
  calls: SqlCall[];
} {
  const { prisma, calls } = fakePrisma(responses);
  return {
    service: new StatsService(prisma as PrismaService),
    calls,
  };
}

/** 把 SQL 模板 + 插值参数还原成一条可读语句 */
function renderSql(call: SqlCall): string {
  const parts = call.text.split('?');
  let out = '';
  parts.forEach((part, index) => {
    out += part;
    if (index < call.values.length) {
      out += renderValue(call.values[index]);
    }
  });
  return out.replace(/\s+/g, ' ').trim();
}

function renderValue(value: unknown): string {
  // Prisma.raw() 的返回值带一个 sql getter —— 列名就藏在那儿
  if (value !== null && typeof value === 'object' && 'sql' in value) {
    return String(value.sql);
  }
  return String(value);
}

/** 包含"此刻"的那个小时的起点，与服务端 window() 的 lastBucket 同一算式 */
const currentHour = (): number => Math.floor(Date.now() / HOUR_MS) * HOUR_MS;

describe('StatsService', () => {
  describe('performanceTrend', () => {
    it('24h 恒定返回 24 个点，且每个点都落在 UTC 整点', async () => {
      const { service } = build([[]]);

      const result = await service.performanceTrend(PROJECT, 'lcp', '24h');

      expect(result.metric).toBe('lcp');
      expect(result.range).toBe('24h');
      expect(result.bucket).toBe('hour');
      expect(result.trend).toHaveLength(24);
      for (const point of result.trend) {
        const t = new Date(point.t);
        expect(t.getUTCMinutes()).toBe(0);
        expect(t.getUTCSeconds()).toBe(0);
        expect(t.getUTCMilliseconds()).toBe(0);
      }
    });

    it('没有样本的桶是 null，不是 0（空桶补断层，不补零）', async () => {
      const { service } = build([[]]);

      const result = await service.performanceTrend(PROJECT, 'lcp', '24h');

      for (const point of result.trend) {
        expect(point.p50).toBeNull();
        expect(point.p75).toBeNull();
        expect(point.p95).toBeNull();
        expect(point.samples).toBe(0);
      }
    });

    it('有样本的桶被放到对应位置（按桶对齐，不是按返回顺序）', async () => {
      const hour = currentHour();
      const { service } = build([
        [
          {
            bucket: new Date(hour),
            p50: 100,
            p75: 200,
            p95: 300,
            samples: 7n, // COUNT 在 PG 里是 bigint，Prisma 给出 BigInt
          },
        ],
      ]);

      const result = await service.performanceTrend(PROJECT, 'lcp', '24h');

      // 最后一个桶 = 包含此刻的那个小时
      expect(result.trend[23]).toEqual({
        t: new Date(hour).toISOString(),
        p50: 100,
        p75: 200,
        p95: 300,
        samples: 7,
      });
      // 相邻的点不受影响
      expect(result.trend[22].p50).toBeNull();
    });

    it('整桶算不出分位数（值为 null）→ 该点仍是 null，不能被兜成 0', async () => {
      // 真实场景：某桶里全是 NULL 样本，又被 WHERE 过滤干净。
      // 若实现里用了"null 当 0"的转换，这里会变成 0，图上就是贴地的假直线。
      const { service } = build([
        [
          {
            bucket: new Date(currentHour()),
            p50: null,
            p75: null,
            p95: null,
            samples: 0n,
          },
        ],
      ]);

      const result = await service.performanceTrend(PROJECT, 'lcp', '24h');

      expect(result.trend[23]).toMatchObject({
        p50: null,
        p75: null,
        p95: null,
        samples: 0,
      });
    });

    it('SQL 里必须排除 NULL 样本、用 percentile_cont、且不出现 date_trunc', async () => {
      const { service, calls } = build([[]]);

      await service.performanceTrend(PROJECT, 'lcp', '24h');

      const sql = renderSql(calls[0]);
      // null 不是 0：混进来会把整桶分位数往 0 拉
      expect(sql).toContain('lcp IS NOT NULL');
      expect(sql).toContain('percentile_cont(0.5) WITHIN GROUP (ORDER BY lcp)');
      expect(sql).toContain(
        'percentile_cont(0.75) WITHIN GROUP (ORDER BY lcp)',
      );
      expect(sql).toContain(
        'percentile_cont(0.95) WITHIN GROUP (ORDER BY lcp)',
      );
      // date_bin 按绝对时长切分；date_trunc 跟会话时区走，换个 TZ 结果就变
      expect(sql).toContain('date_bin');
      expect(sql).not.toContain('date_trunc');
    });

    it('metric 决定查询的列：inp 查 inp，不碰 lcp', async () => {
      const { service, calls } = build([[]]);

      await service.performanceTrend(PROJECT, 'inp', '7d');

      const sql = renderSql(calls[0]);
      expect(sql).toContain('ORDER BY inp');
      expect(sql).toContain('inp IS NOT NULL');
      expect(sql).not.toContain('lcp');
    });

    it('projectId / 窗口端点走参数绑定，不拼进 SQL 文本', async () => {
      const { service, calls } = build([[]]);

      const result = await service.performanceTrend(PROJECT, 'lcp', '24h');

      expect(calls[0].values).toContain(PROJECT);
      // 拼进文本就是注入面；这里必须只出现在参数里
      expect(calls[0].text).not.toContain(PROJECT);
      expect(
        calls[0].values.some(
          (value) =>
            value instanceof Date && value.toISOString() === result.from,
        ),
      ).toBe(true);
    });

    it('7d → 168 个点；30d → 30 个点且按天桶', async () => {
      const week = await build([[]]).service.performanceTrend(
        PROJECT,
        'lcp',
        '7d',
      );
      expect(week.trend).toHaveLength(168);
      expect(week.bucket).toBe('hour');

      const month = await build([[]]).service.performanceTrend(
        PROJECT,
        'lcp',
        '30d',
      );
      expect(month.trend).toHaveLength(30);
      expect(month.bucket).toBe('day');
      // 天桶必须落在 UTC 零点
      expect(new Date(month.trend[0].t).getUTCHours()).toBe(0);
    });

    it('非法 metric 在 service 层就被拒绝，且一条 SQL 都不发', async () => {
      const { service, calls } = build([[]]);

      await expect(
        service.performanceTrend(PROJECT, 'fcp' as never, '24h'),
      ).rejects.toBeInstanceOf(BadRequestException);
      // DTO 是第一道闸，这里是第二道：绕过 DTO 也绝不能把列名拼进 SQL
      expect(calls).toHaveLength(0);
    });
  });

  describe('overview（fillGaps 改为泛型后的回归）', () => {
    it('24h 仍是 24 个点，缺桶补 0（事件数的 0 是正确语义）', async () => {
      const hour = currentHour();
      const { service } = build([
        [{ events: 5n, issues: 1n }],
        [{ n: 0n }],
        [{ bucket: new Date(hour), events: 3n }],
      ]);

      const result = await service.overview(PROJECT, '24h');

      expect(result.trend).toHaveLength(24);
      expect(result.summary).toEqual({ events: 5, issues: 1, new_issues: 0 });
      expect(result.trend[23]).toEqual({
        t: new Date(hour).toISOString(),
        events: 3,
      });
      expect(result.trend[0].events).toBe(0);
    });
  });
});
