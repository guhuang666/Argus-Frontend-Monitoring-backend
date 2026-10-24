import type { AlertRule } from '../../generated/prisma/client';
import {
  AlertDeliveryService,
  buildPayload,
  readBizError,
} from './alert-delivery.service';

const RULE = {
  id: 'r1',
  channel: 'feishu',
  webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret',
} as unknown as AlertRule;

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * 用 jest 的假定时器跳过 1/2/4 秒退避。
 *
 * 真实等待会让这个文件跑 7 秒以上，而单测的价值在"断言重试次数与顺序"，
 * 不在"证明 setTimeout 好用"。`advanceTimersByTimeAsync` 会把定时器和
 * 已排队的 Promise 一起推进，所以 fetch 的 resolve 也会被正确串起来。
 */
async function deliverWithTimers(
  service: AlertDeliveryService,
  advanceMs: number,
): Promise<Awaited<ReturnType<AlertDeliveryService['deliver']>>> {
  const promise = service.deliver(RULE, 'hello');
  await jest.advanceTimersByTimeAsync(advanceMs);
  return promise;
}

describe('AlertDeliveryService（M6-4）', () => {
  let service: AlertDeliveryService;

  beforeEach(() => {
    service = new AlertDeliveryService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('5xx 之后重试，第二次成功 → attempts=2', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(500, 'boom'))
      .mockResolvedValueOnce(response(200, '{"code":0}'));

    const result = await deliverWithTimers(service, 1_500);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('4xx 不重试（地址错了重试一万次也一样）', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(404, 'not found'));

    const result = await deliverWithTimers(service, 10_000);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('HTTP 404');
  });

  it('一直 500：首试 + 3 次重试后放弃', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(503, 'unavailable'));

    const result = await deliverWithTimers(service, 8_000);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('网络错误也重试（对端重启是常见场景）', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(response(200, '{"code":0}'));

    const result = await deliverWithTimers(service, 1_500);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTTP 200 但飞书返回 errcode 不为 0：算失败，且不重试', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(200, '{"code":19021,"msg":"sign match fail"}'));

    const result = await deliverWithTimers(service, 10_000);

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('code=19021');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('三家 payload 形状', () => {
  it('飞书 / 钉钉 / Slack 各按自己的字段包一层', () => {
    expect(buildPayload('feishu', 'x')).toEqual({ msg_type: 'text', content: { text: 'x' } });
    expect(buildPayload('dingtalk', 'x')).toEqual({ msgtype: 'text', text: { content: 'x' } });
    expect(buildPayload('slack', 'x')).toEqual({ text: 'x' });
  });

  it('业务错误码解析：0 是成功，非 0 是失败，非 JSON 按成功', () => {
    expect(readBizError('{"code":0}')).toBeNull();
    expect(readBizError('{"errcode":310000,"errmsg":"token 无效"}')).toContain('errcode=310000');
    expect(readBizError('ok')).toBeNull();
  });
});
