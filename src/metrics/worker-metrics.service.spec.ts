import { WorkerMetricsService } from './worker-metrics.service';
import { registry } from './metrics.registry';

/**
 * worker 侧埋点（M6-7 v1，只计数）。
 *
 * 断言读 `registry.metrics()` 的文本，等价于 Prometheus 将来看到的东西 ——
 * 指标名、标签名拼错了这里立刻会红。
 *
 * 用 `inc` 的绝对差值断言而不是固定值：registry 是模块级单例，
 * 同一个 jest 进程里多个用例共享它，写死数字会随执行顺序碎掉。
 */
async function readValue(needle: string): Promise<number> {
  const text = await registry.metrics();
  const line = text.split('\n').find((row) => row.startsWith(needle));
  if (line === undefined) return 0;
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('WorkerMetricsService（M6-7 v1）', () => {
  it('recordAttempt 按结果分桶累加', async () => {
    const service = new WorkerMetricsService();
    const beforeOk = await readValue('argus_job_attempts_total{result="succeeded"}');
    const beforeFail = await readValue('argus_job_attempts_total{result="failed"}');

    service.recordAttempt('succeeded');
    service.recordAttempt('succeeded');
    service.recordAttempt('failed');

    expect(await readValue('argus_job_attempts_total{result="succeeded"}')).toBe(beforeOk + 2);
    expect(await readValue('argus_job_attempts_total{result="failed"}')).toBe(beforeFail + 1);
  });

  it('recordDlq 按 project_id 累加', async () => {
    const service = new WorkerMetricsService();
    const needle = 'argus_dlq_jobs_total{project_id="p-test"}';
    const before = await readValue(needle);

    service.recordDlq('p-test');

    expect(await readValue(needle)).toBe(before + 1);
  });

  it('指标名与标签与 Prometheus 的约定一致（拼写回归防线）', async () => {
    const text = await registry.metrics();

    expect(text).toContain('# TYPE argus_job_attempts_total counter');
    expect(text).toContain('# TYPE argus_dlq_jobs_total counter');
  });

  it('attempts 的 help 写明是"尝试次数"，避免被当成 job 数', async () => {
    const text = await registry.metrics();

    expect(text).toContain('# HELP argus_job_attempts_total 归并 job 的处理尝试次数');
  });
});
