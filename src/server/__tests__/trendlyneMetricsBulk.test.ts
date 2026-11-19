import { afterEach, describe, expect, it, vi } from 'vitest';

const { dbAll, dbRun } = vi.hoisted(() => ({
  dbAll: vi.fn(),
  dbRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../dbAsync', () => ({ dbAll, dbRun }));

import { runTrendlyneMetricsBulkFetch } from '../trendlyneDailyFetchService';

const HEADERS = ['NSEcode', 'stock_id', 'PE_TTM', 'PBV_A', 'ROE_A'].map(unique_name => ({ unique_name }));

function page(rows: unknown[][], isNextPage: boolean) {
  return new Response(JSON.stringify({
    head: { status: '0', isNextPage },
    body: { tableHeaders: HEADERS, tableData: rows, isNextPage },
  }), { status: 200 });
}

describe('runTrendlyneMetricsBulkFetch (one anonymous custom-query sweep, AF-20261119-03)', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('pages until isNextPage is false and stores only ACTIVE NSE symbols under the IST date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T19:23:17Z')); // 00:53 IST on 11-07
    dbAll.mockResolvedValue([{ symbol: 'RELIANCE' }, { symbol: 'TCS' }]);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(page([['RELIANCE', 1127, 22.46, 1.99, ''], ['', 999, 5, 1, 1]], true))
      .mockResolvedValueOnce(page([['TCS', 1373, 24.1, 'n/a', 45.2], ['NOTOURS', 1, 1, 1, 1]], false));

    const res = await runTrendlyneMetricsBulkFetch({ fetchFn, pageDelayMs: 0 });

    expect(res).toEqual({ pages: 2, persisted: 2 });
    expect(fetchFn.mock.calls.map(c => new URL(String(c[0])).searchParams.get('pageNumber'))).toEqual(['0', '1']);
    const cols = String(dbRun.mock.calls[0][0]).match(/\(symbol, date, ([^)]*), fetched_at\)/)![1].split(', ');
    const rows = dbRun.mock.calls.map(c => Object.fromEntries(
      [['symbol', c[1][0]], ['date', c[1][1]], ...cols.map((col, i) => [col, c[1][i + 2]])]));
    expect(rows.map(r => [r.symbol, r.date])).toEqual([['RELIANCE', '2026-11-07'], ['TCS', '2026-11-07']]);
    expect(rows[0]).toMatchObject({ pe_ttm: 22.46, pbv_a: 1.99, roe_a: null, mcap_q: null });
    expect(rows[1]).toMatchObject({ pe_ttm: 24.1, pbv_a: null, roe_a: 45.2 });
  });

  it('fails loudly on a refused page instead of reporting a partial sweep as success', async () => {
    dbAll.mockResolvedValue([{ symbol: 'RELIANCE' }]);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(page([['RELIANCE', 1127, 22.46, 1.99, 8.9]], true))
      .mockResolvedValueOnce(new Response('blocked', { status: 405 }));

    await expect(runTrendlyneMetricsBulkFetch({ fetchFn, pageDelayMs: 0 })).rejects.toThrow(/page 1.*405/);
    expect(dbRun).toHaveBeenCalledTimes(1);
  });

  it('fails when the sweep matched no universe symbol', async () => {
    dbAll.mockResolvedValue([{ symbol: 'RELIANCE' }]);
    const fetchFn = vi.fn().mockResolvedValueOnce(page([['OTHER', 1, 1, 1, 1]], false));

    await expect(runTrendlyneMetricsBulkFetch({ fetchFn, pageDelayMs: 0 })).rejects.toThrow(/0 universe symbols/);
  });
});
