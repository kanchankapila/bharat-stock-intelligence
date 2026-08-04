import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

// gnews_enabled defaults to a row-less/false state; individual tests flip it via this map.
const appSettings: Record<string, string> = {};

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async (sql: string, params?: any[]) => {
    if (String(sql).includes('app_settings')) {
      const key = params?.[0];
      return key in appSettings ? { value: appSettings[key] } : undefined;
    }
    return undefined;
  }),
  dbAll: vi.fn().mockResolvedValue([]), // ensureNSESymbols()/stock universes -- empty is fine here
  dbRun: vi.fn(),
  dbTransaction: vi.fn(async (fn: any) => fn({ run: vi.fn() })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { runGNewsMarketCycle, runGNewsGlobalCycle, runGNewsStocksCycle } = await import('../newsSentimentService');

function gnewsResponse(articles: any[]) {
  return { ok: true, status: 200, json: async () => ({ totalArticles: articles.length, articles }) } as any;
}

const SAMPLE_ARTICLE = {
  title: 'Sensex gains 200 points on strong earnings',
  description: 'Indian markets rallied Thursday as IT stocks led gains.',
  url: 'https://example.com/article-1',
  publishedAt: '2026-08-04T09:00:00Z',
  source: { name: 'Example News' },
};

describe('GNews cycles', () => {
  const origKey = process.env.GNEWS_API_KEY;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers(); // runGNewsMarketCycle's inter-call pacing delay would otherwise really elapse
    for (const k of Object.keys(appSettings)) delete appSettings[k];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (origKey === undefined) delete process.env.GNEWS_API_KEY;
    else process.env.GNEWS_API_KEY = origKey;
  });

  test('is a silent no-op when GNEWS_API_KEY is not set, even if gnews_enabled=true -- never calls fetch', async () => {
    delete process.env.GNEWS_API_KEY;
    appSettings.gnews_enabled = 'true';
    const result = await runGNewsMarketCycle();
    expect(result).toEqual({ fetched: 0, inserted: 0, skipped: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('is a silent no-op when a key is set but gnews_enabled is not explicitly true (default off, 12h-delay caveat)', async () => {
    process.env.GNEWS_API_KEY = 'test-key';
    // appSettings.gnews_enabled intentionally left unset
    const result = await runGNewsMarketCycle();
    expect(result).toEqual({ fetched: 0, inserted: 0, skipped: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('runs when both the key is set and gnews_enabled=true', async () => {
    process.env.GNEWS_API_KEY = 'test-key';
    appSettings.gnews_enabled = 'true';
    mockFetch.mockResolvedValue(gnewsResponse([SAMPLE_ARTICLE]));

    const p = runGNewsMarketCycle();
    await vi.runAllTimersAsync(); // the 1.2s inter-call pacing delay
    const result = await p;

    expect(result.skipped).toBeFalsy();
    expect(mockFetch).toHaveBeenCalledTimes(2); // market cycle = business headlines + NSE/BSE search
    const urls = mockFetch.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some(u => u.includes('top-headlines') && u.includes('country=in'))).toBe(true);
    expect(urls.some(u => u.includes('/search') && u.includes('country=in'))).toBe(true);
    expect(urls.every(u => u.includes('apikey=test-key'))).toBe(true);
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
  });

  test('runGNewsGlobalCycle makes exactly 1 call (world business headlines) and tags it GLOBAL', async () => {
    process.env.GNEWS_API_KEY = 'test-key';
    appSettings.gnews_enabled = 'true';
    mockFetch.mockResolvedValue(gnewsResponse([SAMPLE_ARTICLE]));

    const result = await runGNewsGlobalCycle();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('country=us');
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(1);
  });

  test('runGNewsStocksCycle skips cleanly when the rotating universe query returns nothing', async () => {
    process.env.GNEWS_API_KEY = 'test-key';
    appSettings.gnews_enabled = 'true';
    // dbAll (the universe query) is mocked to return [] globally in this file -- an empty
    // universe must short-circuit before ever calling fetch.
    const result = await runGNewsStocksCycle();
    expect(result.fetched).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('skips an article with no url (no stable dedup id) instead of crashing', async () => {
    process.env.GNEWS_API_KEY = 'test-key';
    appSettings.gnews_enabled = 'true';
    mockFetch.mockResolvedValue(gnewsResponse([{ ...SAMPLE_ARTICLE, url: '' }]));

    const result = await runGNewsGlobalCycle();
    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);
  });

  test('a failed HTTP response does not throw and does not leak the api key into logs', async () => {
    process.env.GNEWS_API_KEY = 'secret-key-xyz';
    appSettings.gnews_enabled = 'true';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: false, status: 429 } as any);

    const result = await runGNewsGlobalCycle();
    expect(result.fetched).toBe(0);
    expect(warnSpy.mock.calls.every(call => !String(call.join(' ')).includes('secret-key-xyz'))).toBe(true);
    warnSpy.mockRestore();
  });
});
