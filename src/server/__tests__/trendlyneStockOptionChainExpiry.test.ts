import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({ dbGet: vi.fn(), dbAll: vi.fn() }));
vi.mock('../stockMapping', () => ({ getStockMapping: vi.fn().mockReturnValue(undefined) }));
vi.mock('../cacheService', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../trendlyneAuthService', () => ({ fetchTrendlyneWithAuth: vi.fn() }));

const { fetchTrendlyneStockOptionChain } = await import('../trendlyneService');

describe('fetchTrendlyneStockOptionChain expiry fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the month-end Tuesday, not a Thursday, when no expiry is given and the lookup fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T06:00:00Z'));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('niftytrader')) throw new Error('lookup down');
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchTrendlyneStockOptionChain('RELIANCE');

    const chainUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('smartoptions'))!;
    expect(chainUrl).toContain('expDate=2026-11-24');
  });
});
