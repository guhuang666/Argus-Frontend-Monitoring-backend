import {
  ERROR_EVENT_DLQ,
  ERROR_EVENT_JOB,
  ERROR_EVENT_JOB_OPTIONS,
  ERROR_EVENT_QUEUE,
  toJobId,
} from './queue.constants';

describe('队列契约', () => {
  it('队列名 / job 名固定下来（改名等于换队列，历史 job 会变成孤儿）', () => {
    expect(ERROR_EVENT_QUEUE).toBe('error-events');
    expect(ERROR_EVENT_DLQ).toBe('error-events-dlq');
    expect(ERROR_EVENT_JOB).toBe('error-event');
  });

  it('重试策略：3 次总尝试 + 指数退避', () => {
    expect(ERROR_EVENT_JOB_OPTIONS.attempts).toBe(3);
    expect(ERROR_EVENT_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('失败的 job 立刻删掉 —— 留着会把 W8 补扫的去重路堵死', () => {
    expect(ERROR_EVENT_JOB_OPTIONS.removeOnFail).toBe(true);
  });

  it('成功的 job 保留一小时：这就是 jobId 去重的有效窗口', () => {
    expect(ERROR_EVENT_JOB_OPTIONS.removeOnComplete).toEqual({ age: 3600, count: 5000 });
  });
});

describe('toJobId', () => {
  it('UUID 原样返回（常规路径：jobId 就是 event_id）', () => {
    expect(toJobId('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('SDK 的十六进制兜底 id 原样返回', () => {
    expect(toJobId('18f2a3b4c5d6e7f8')).toBe('18f2a3b4c5d6e7f8');
  });

  it('纯数字加 e- 前缀（BullMQ: Custom Id cannot be integers）', () => {
    expect(toJobId('12345')).toBe('e-12345');
    expect(toJobId('0')).toBe('e-0');
  });

  it('冒号被百分号编码（BullMQ: Custom Id cannot contain :）', () => {
    expect(toJobId('a:b')).toBe('a%3Ab');
    expect(toJobId('a:b:c:d')).toBe('a%3Ab%3Ac%3Ad');
  });

  it('映射是单射：a:b 与 a_b 不会互相顶掉', () => {
    expect(toJobId('a:b')).not.toBe(toJobId('a_b'));
  });

  it('字面量 %3A 不会被误当成冒号（% 先编码）', () => {
    expect(toJobId('a%3Ab')).toBe('a%253Ab');
    expect(toJobId('a%3Ab')).not.toBe(toJobId('a:b'));
  });

  it.each([
    '550e8400-e29b-41d4-a716-446655440000',
    '18f2a3b4c5d6e7f8',
    '12345',
    '0',
    'a:b',
    'a%3Ab',
    'a:b:c:d',
    '  空格 也照收  ',
    '1234567890123456789012345678901234567890',
  ])('任何输入都不触发 BullMQ 的两条 id 校验: %s', (eventId) => {
    const jobId = toJobId(eventId);

    expect(jobId.includes(':')).toBe(false); // Custom Id cannot contain :
    expect(`${parseInt(jobId, 10)}`).not.toBe(jobId); // Custom Id cannot be integers
    expect(jobId).not.toBe('');
  });
});
