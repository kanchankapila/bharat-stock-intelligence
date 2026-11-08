import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-11-06: a login attempted during a Trendlyne 502 outage returned no session cookie, was
// cached anyway because the csrftoken from the login page made the cookie header non-empty, and
// every stock-metrics fetch for the next ~6h came back as the anonymous (body-less) payload:
// 648 gated responses, trendlyne-daily-fetch 244/500 failed. Probed live 2026-11-07: a failed
// login is 200 + csrftoken only; a real one is 302 + a `.trendlyne` session cookie.

process.env.TRENDLYNE_USERNAME = 'user@example.com';
process.env.TRENDLYNE_PASSWORD = 'pw';

function res(status: number, cookies: string[], body = '<input name="csrfmiddlewaretoken" value="tok">') {
  const headers = new Headers();
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

const LOGIN_PAGE = () => res(200, ['csrftoken=abc; Path=/']);

describe('Trendlyne login must not cache an anonymous session', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects a login POST that returns 200 with only a rotated csrftoken', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? res(200, ['csrftoken=rotated; Path=/']) : LOGIN_PAGE());
    vi.stubGlobal('fetch', fetchMock);
    const { getTrendlyneAuthHeaders } = await import('../trendlyneAuthService');

    const p = getTrendlyneAuthHeaders();
    await vi.runAllTimersAsync();
    expect(await p).toEqual({});
  });

  it('accepts a 302 login that sets a session cookie', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? res(302, ['csrftoken=rotated; Path=/', '.trendlyne=sess123; Path=/; HttpOnly'])
        : LOGIN_PAGE()));
    const { getTrendlyneAuthHeaders } = await import('../trendlyneAuthService');

    const headers = await getTrendlyneAuthHeaders();
    expect(headers.Cookie).toContain('.trendlyne=sess123');
  });
});

describe('a gated stock-metrics payload drops the cached session', () => {
  it('invalidates the session so the next fetch logs in again', async () => {
    vi.resetModules();
    const invalidate = vi.fn();
    vi.doMock('../trendlyneAuthService', () => ({
      fetchTrendlyneWithAuth: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
      invalidateTrendlyneSession: invalidate,
    }));
    vi.doMock('../dbAsync', () => ({ dbGet: vi.fn().mockResolvedValue({ tlid: '49' }) }));
    vi.doMock('../stockMapping', () => ({ getStockMapping: vi.fn().mockReturnValue(undefined) }));
    vi.doMock('../cacheService', () => ({
      cacheGet: vi.fn().mockResolvedValue(null),
      cacheSet: vi.fn().mockResolvedValue(undefined),
    }));
    const { fetchTrendlyneStockMetrics } = await import('../trendlyneService');

    await expect(fetchTrendlyneStockMetrics('AJANTPHARM')).resolves.toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
