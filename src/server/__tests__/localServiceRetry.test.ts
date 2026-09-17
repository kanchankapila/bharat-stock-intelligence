import { describe, it, expect, vi } from 'vitest';
import { retryOnConnectionError, isConnectionError } from '../localServiceRetry';

describe('isConnectionError', () => {
  it('matches the shapes the three failing jobs actually produced', () => {
    expect(isConnectionError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectionError(new TypeError('fetch failed'))).toBe(true);
    expect(isConnectionError(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))).toBe(true);
  });
  it('does NOT match a service that answered', () => {
    expect(isConnectionError(new Error('chatbot /ingest returned 500: boom'))).toBe(false);
    expect(isConnectionError(new Error('ValueError in scorer'))).toBe(false);
  });
  it('survives a self-referential cause chain', () => {
    const e: any = new Error('x'); e.cause = e;
    expect(isConnectionError(e)).toBe(false);
  });
});

describe('retryOnConnectionError', () => {
  it('recovers when the service comes back', async () => {
    let n = 0;
    const p = retryOnConnectionError(async () => {
      if (++n < 3) throw new TypeError('fetch failed');
      return 'ok';
    }, { baseDelayMs: 1 });
    expect(await p).toBe('ok');
    expect(n).toBe(3);
  });
  it('does NOT retry a real HTTP failure -- it must surface on the first try', async () => {
    let n = 0;
    await expect(retryOnConnectionError(async () => {
      n++; throw new Error('chatbot /ingest returned 500: boom');
    }, { baseDelayMs: 1 })).rejects.toThrow('returned 500');
    expect(n).toBe(1);
  });
  it('gives up and rethrows the original error after the last attempt', async () => {
    let n = 0;
    await expect(retryOnConnectionError(async () => {
      n++; throw new TypeError('fetch failed');
    }, { attempts: 2, baseDelayMs: 1 })).rejects.toThrow('fetch failed');
    expect(n).toBe(2);
  });
});
