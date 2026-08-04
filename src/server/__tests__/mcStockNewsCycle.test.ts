import { vi, describe, test, expect, beforeEach } from 'vitest';

const universeRows = [{ symbol: 'RELIANCE' }, { symbol: 'TCS' }, { symbol: 'BADSYMBOL' }];

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(),
  dbAll: vi.fn(async () => universeRows),
  dbRun: vi.fn(),
  dbTransaction: vi.fn(async (fn: any) => fn({ run: vi.fn() })),
}));

vi.mock('../stockMapping', () => ({
  resolveMoneycontrolSymbol: vi.fn(async (symbol: string) => {
    if (symbol === 'RELIANCE') return 'RI';
    if (symbol === 'TCS') return 'TCS';
    return null; // BADSYMBOL has no MC mapping
  }),
}));

vi.mock('../mcApiService', () => ({
  fetchMcStockNews: vi.fn(async (scId: string, symbol?: string) => {
    if (scId === 'RI') {
      return {
        scId, status: 'ok', count: 1,
        news: [{
          heading: 'Reliance Q1 profit beats estimates',
          summary: 'RIL reported strong refining margins.',
          posturl: 'https://www.moneycontrol.com/news/reliance-q1-123.html',
          creation_date_epoch: '1785472647',
          update_date_epoch: '1785472798',
          display_date: 'Jul 31, 2026',
          post_type: 'news',
          post_image: '',
        }],
        additional_links: [],
      };
    }
    if (scId === 'TCS') {
      return { scId, status: 'no_news', count: 0, news: [], additional_links: [] };
    }
    return { scId, status: 'fetch_failed', count: 0, news: [], additional_links: [] };
  }),
}));

const { runMcStockNewsCycle } = await import('../newsSentimentService');

describe('runMcStockNewsCycle', () => {
  beforeEach(() => {
    universeRows.length = 0;
    universeRows.push({ symbol: 'RELIANCE' }, { symbol: 'TCS' }, { symbol: 'BADSYMBOL' });
  });

  test('resolves each symbol to its MC scId, fetches news, and force-tags it to that symbol', async () => {
    const result = await runMcStockNewsCycle(10);
    expect(result.companies).toBe(3);
    expect(result.inserted).toBe(1); // only RELIANCE had status 'ok' with a real article
  });

  test('a symbol with no MC mapping (resolveMoneycontrolSymbol -> null) is skipped, not crashed on', async () => {
    universeRows.length = 0;
    universeRows.push({ symbol: 'BADSYMBOL' });
    const result = await runMcStockNewsCycle(10);
    expect(result.companies).toBe(1);
    expect(result.inserted).toBe(0);
  });

  test('an empty universe short-circuits before any resolution/fetch work', async () => {
    universeRows.length = 0;
    const result = await runMcStockNewsCycle(10);
    expect(result).toEqual({ companies: 0, inserted: 0 });
  });

  test("'no_news' and 'fetch_failed' are both treated as a clean skip for that stock, not an error", async () => {
    universeRows.length = 0;
    universeRows.push({ symbol: 'TCS' }); // status: 'no_news' per the mock above
    const result = await runMcStockNewsCycle(10);
    expect(result.companies).toBe(1);
    expect(result.inserted).toBe(0);
  });
});
