import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

// ─── Unit tests (mocked network + DB) — always run ─────────────────────────────

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn().mockResolvedValue(undefined),
  dbAll: vi.fn(async (sql: string) => {
    if (String(sql).includes('days_to_next_results')) {
      return [{ symbol: 'RELIANCE' }]; // real stocklist entry, mcsymbol 'RI'
    }
    if (String(sql).includes('nse_stocks')) {
      // ensureNSESymbols()'s alias-index source -- needed for the NSE RSS title-based tagger.
      return [{ symbol: 'RELIANCE', name: 'Reliance Industries Limited' }];
    }
    return [];
  }),
  dbRun: vi.fn(),
  dbTransaction: vi.fn(async (fn: any) => fn({ run: vi.fn() })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const {
  runNseAnnouncementsCycle, runNseFinancialResultsCycle,
  runMcEarningsNewsCycle, runMcDealsNewsCycle,
} = await import('../newsSentimentService');

function nseRssResponse(items: { title: string; description: string; pubDate: string; link: string }[]) {
  const body = `<?xml version="1.0"?><rss><channel>${items.map(i => `<item>
    <title>${i.title}</title>
    <link>${i.link}</link>
    <description>${i.description}</description>
    <pubDate>${i.pubDate}</pubDate>
  </item>`).join('')}</channel></rss>`;
  return { ok: true, status: 200, text: async () => body } as any;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body } as any;
}

describe('NSE RSS cycles', () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.clearAllMocks());

  test('force-tags an item to the resolved symbol via its title (company legal name), not prose scanning', async () => {
    mockFetch.mockResolvedValue(nseRssResponse([{
      title: 'Reliance Industries Limited',
      description: 'Reliance Industries Limited has informed the Exchange about Board Meeting |SUBJECT: Results',
      pubDate: '13-Aug-2026 15:14:11',
      link: 'https://nsearchives.nseindia.com/corporate/x.pdf',
    }]));
    const result = await runNseAnnouncementsCycle();
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(1);
  });

  test('an item whose title does not resolve to any tracked NSE symbol is skipped, not inserted', async () => {
    mockFetch.mockResolvedValue(nseRssResponse([{
      title: 'Some Totally Unmapped Shell Company Pvt Ltd',
      description: 'informed the Exchange about something',
      pubDate: '13-Aug-2026 15:14:11',
      link: 'https://nsearchives.nseindia.com/corporate/y.pdf',
    }]));
    const result = await runNseAnnouncementsCycle();
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(0);
  });

  test('a non-OK HTTP response is a clean no-op, not a throw', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const result = await runNseFinancialResultsCycle();
    expect(result).toEqual({ fetched: 0, inserted: 0 });
  });

  test('sends browser-shaped headers, not the generic NEWS_SOURCES User-Agent — nsearchives.nseindia.com silently blackholes the latter (live-verified 2026-08-13)', async () => {
    mockFetch.mockResolvedValue(nseRssResponse([]));
    await runNseAnnouncementsCycle();
    const [, opts] = mockFetch.mock.calls[0];
    expect(String(opts.headers['User-Agent'])).toMatch(/Chrome/);
    expect(opts.headers['Referer']).toBe('https://www.nseindia.com/');
  });
});

describe('runMcEarningsNewsCycle', () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.clearAllMocks());

  test('queries only symbols within the days_to_next_results window, and force-tags articles to that symbol', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      '0': {
        id: '1', headline: 'Reliance Q1 Net Profit Up 12%', intro: '',
        posturl: 'https://moneycontrol.com/a/1', creation_date_epoch: '1786600000', update_date_epoch: '1786600000',
      },
    }));
    const result = await runMcEarningsNewsCycle();
    expect(result.symbols).toBe(1);
    expect(result.inserted).toBe(1);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('related_scid');
    expect(url).toContain('RI'); // RELIANCE's mcsymbol
  });

  test('an item with no posturl is skipped -- no stable id to dedup on', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      '0': { id: '1', headline: 'X', intro: '', posturl: '', creation_date_epoch: '', update_date_epoch: '' },
    }));
    const result = await runMcEarningsNewsCycle();
    expect(result.inserted).toBe(0);
  });
});

describe('runMcDealsNewsCycle', () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.clearAllMocks());

  test('resolves each item to an NSE symbol via its own scid, force-tags it', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: 1,
      data: [{
        id: '1', heading: 'Reliance Industries shares rise 2%', posturl: 'https://moneycontrol.com/a/1',
        scid: 'RI', cmp: '2500', perChange: '2.0', update_date_epoch: '1786600000',
      }],
    }));
    const result = await runMcDealsNewsCycle();
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(1);
  });

  test('an scid outside the 2,005-stock mapping table is skipped, not guessed', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: 1,
      data: [{
        id: '1', heading: 'X', posturl: 'https://moneycontrol.com/a/1',
        scid: 'ZZZ999NOTREAL', cmp: '1', perChange: '1', update_date_epoch: '1786600000',
      }],
    }));
    const result = await runMcDealsNewsCycle();
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(0);
  });

  test('success !== 1 or a missing data array is a clean no-op', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: 0 }));
    const result = await runMcDealsNewsCycle();
    expect(result).toEqual({ fetched: 0, inserted: 0 });
  });
});

// ─── LIVE DATASOURCE TESTS — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1 ────
//
// Hits the real endpoints, parses with the real fetcher functions (mcApiService's
// parseMcRelatedNews/parseMcDealsNews, newsSentimentService's real fetchNseRss+parseRSS), and
// asserts a non-empty, correctly-shaped response. Per data-sources.md: this is what would have
// caught the header-gate finding above (nsearchives.nseindia.com silently blackholes the
// generic NEWS_SOURCES User-Agent) before it shipped, if written before the fetch was verified
// by hand -- written after, here, so it stays caught.
//
//   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/newsSentimentNseAndMcExtras.test.ts
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';

describe.runIf(RUN_LIVE)('NSE + MC extras [live]', () => {
  test('NSE Online_announcements RSS returns real, parseable items', async () => {
    vi.unstubAllGlobals();
    const { fetchNseRss, NSE_RSS_FEEDS } = await vi.importActual<typeof import('../newsSentimentService')>('../newsSentimentService');
    const feed = NSE_RSS_FEEDS.find(f => f.key === 'announcements')!;
    const items = await fetchNseRss(feed.url);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].title.length).toBeGreaterThan(0);
  }, 20000);

  test('MC per-stock earnings news (related_scid) returns a real, correctly-shaped response for a known scid', async () => {
    vi.unstubAllGlobals();
    const { fetchMcEarningsNews } = await vi.importActual<typeof import('../mcApiService')>('../mcApiService');
    // BE03 = Bharat Electronics, a large, reliably-covered name -- live-verified 2026-08-13.
    const res = await fetchMcEarningsNews('BE03', 'BEL');
    expect(res.status).toBe('ok');
    expect(res.news.length).toBeGreaterThan(0);
    expect(res.news[0].headline.length).toBeGreaterThan(0);
  }, 20000);

  test('MC deals/get-stock-news returns real, scid-tagged items', async () => {
    vi.unstubAllGlobals();
    const { fetchMcDealsNews } = await vi.importActual<typeof import('../mcApiService')>('../mcApiService');
    const items = await fetchMcDealsNews();
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].scid.length).toBeGreaterThan(0);
    expect(items[0].heading.length).toBeGreaterThan(0);
  }, 20000);
});
