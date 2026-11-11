import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import axios from 'axios';
import { postWithRateLimitRetry } from '../telegramService';

/**
 * 2026-11-07 22:50 IST: job-digest failed with "read ECONNRESET" and the heartbeat recorded a
 * digest nobody received. postWithRateLimitRetry retried only HTTP 429, so a connection reset
 * (no HTTP response at all) was thrown on the first attempt. The same loss already happened to a
 * 429 on 2026-09-08 and was fixed for that one status only.
 */
const post = vi.mocked(axios.post);
const resetErr = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

async function run(p: Promise<void>) {
  // Attach the handler before timers fire so a rejection is never unhandled.
  const settled = p.then(() => 'ok', (e: any) => `rejected:${e.code ?? e.response?.status ?? e.message}`);
  await vi.runAllTimersAsync();
  return settled;
}

describe('postWithRateLimitRetry on transient network failures', () => {
  beforeEach(() => { vi.useFakeTimers(); post.mockReset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('retries a connection reset and delivers on the next attempt', async () => {
    post.mockRejectedValueOnce(resetErr()).mockResolvedValueOnce({ data: {} } as any);
    expect(await run(postWithRateLimitRetry('u', { text: 'digest' }))).toBe('ok');
    expect(post).toHaveBeenCalledTimes(2);
  });

  // 2026-11-11 10:14 / 13:19 IST: on a wake from Windows Modern Standby the adapter is not up
  // yet and getaddrinfo answers ENOTFOUND (not EAI_AGAIN) for api.telegram.org; 5 alerts were lost.
  it('retries a DNS lookup failure (ENOTFOUND) on a fixed, well-known host', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), { code: 'ENOTFOUND' }))
      .mockResolvedValueOnce({ data: {} } as any);
    expect(await run(postWithRateLimitRetry('u', { text: 'digest' }))).toBe('ok');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retries a 502 from the gateway', async () => {
    post.mockRejectedValueOnce({ response: { status: 502 } }).mockResolvedValueOnce({ data: {} } as any);
    expect(await run(postWithRateLimitRetry('u', { text: 'digest' }))).toBe('ok');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded number of attempts and surfaces the error', async () => {
    post.mockRejectedValue(resetErr());
    expect(await run(postWithRateLimitRetry('u', { text: 'digest' }))).toBe('rejected:ECONNRESET');
    expect(post).toHaveBeenCalledTimes(3);
  });

  // Negative controls: these must NOT be retried, or a bad token/payload would hammer the API
  // and a malformed message would be sent repeatedly.
  it('does not retry a 400 (bad payload) or a 401 (bad token)', async () => {
    post.mockRejectedValue({ response: { status: 400, data: { description: "can't parse entities" } } });
    expect(await run(postWithRateLimitRetry('u', { text: 'x' }))).toBe('rejected:400');
    expect(post).toHaveBeenCalledTimes(1);
    post.mockReset();
    post.mockRejectedValue({ response: { status: 401 } });
    expect(await run(postWithRateLimitRetry('u', { text: 'x' }))).toBe('rejected:401');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error that is not a network failure', async () => {
    post.mockRejectedValue(new TypeError('payload is not serialisable'));
    expect(await run(postWithRateLimitRetry('u', { text: 'x' }))).toBe('rejected:payload is not serialisable');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
