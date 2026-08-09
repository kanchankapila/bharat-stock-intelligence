import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn().mockResolvedValue(undefined),
  dbAll: vi.fn().mockResolvedValue([]), // ensureNSESymbols() — empty universe is fine here
  dbRun: vi.fn(),
  dbTransaction: vi.fn(async (fn: any) => fn({ run: vi.fn() })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { runInvestingIdeasCycle } = await import('../newsSentimentService');

function rssResponse(items: { title: string; link: string; pubDate: string; description: string }[]) {
  const body = `<?xml version="1.0"?><rss><channel>${items.map(i => `<item>
    <title>${i.title}</title>
    <link>${i.link}</link>
    <pubDate>${i.pubDate}</pubDate>
    <description>${i.description}</description>
  </item>`).join('')}</channel></rss>`;
  return { ok: true, status: 200, text: async () => body } as any;
}

const SAMPLE_ITEM = {
  title: 'Nomura maintains Buy on Infosys, raises target price',
  link: 'https://in.investing.com/news/stock-market-news/sample-1',
  pubDate: '2026-08-04 12:07:51',
  description: 'Brokerage sees 15% upside on strong Q1 execution.',
};

describe('runInvestingIdeasCycle', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('fetches both INVESTING_SOURCES feeds (stock ideas + global economy)', async () => {
    mockFetch.mockResolvedValue(rssResponse([SAMPLE_ITEM]));

    const result = await runInvestingIdeasCycle();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some(u => u.includes('news_1065.rss'))).toBe(true);
    expect(urls.some(u => u.includes('news_14.rss'))).toBe(true);
    expect(result.fetched).toBe(2); // 1 item from each of the 2 feeds
    expect(result.inserted).toBe(2);
  });

  test('parses the bare `YYYY-MM-DD HH:mm:ss` pubDate format without throwing', async () => {
    mockFetch.mockResolvedValue(rssResponse([SAMPLE_ITEM]));

    // A malformed/unparseable pubDate would be caught internally (processNewsItem wraps the
    // Date parse in try/catch), so the real assertion here is that the whole cycle completes
    // and inserts rows rather than silently losing every item to a parse exception.
    const result = await runInvestingIdeasCycle();
    expect(result.inserted).toBeGreaterThan(0);
  });

  test('a failed HTTP response on one feed does not block the other, and does not throw', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('news_1065')) return Promise.resolve({ ok: false, status: 503 } as any);
      return Promise.resolve(rssResponse([SAMPLE_ITEM]));
    });

    const result = await runInvestingIdeasCycle();
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(1);
  });

  test('an empty response from both feeds is a clean no-op, not an error', async () => {
    mockFetch.mockResolvedValue(rssResponse([]));

    const result = await runInvestingIdeasCycle();
    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);
  });
});
