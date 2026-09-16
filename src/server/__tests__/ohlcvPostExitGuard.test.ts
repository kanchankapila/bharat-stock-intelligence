import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AF-20260914-05. 48 delisted/suspended names kept receiving one bar per trading day from the
 * live-quote refresh (3,199 fabricated bars purged 2026-09-14; SRTRANSFIN's exchange record
 * ends 2022-12 and it was STILL getting bars). The bars have plausible shape (high>low,
 * volume>0) so the closed-market guard cannot see them -- the fix drops the names at persist
 * time, using nse_universe_history (the exchange's own record) as the authority on whether a
 * symbol still trades. These tests pin the filter semantics at the persist boundary.
 *
 * AF-20260915-10. Extended with a canonical universe allowlist: symbols not in nse_stocks
 * are dropped before the post-exit check even runs, closing the gap where ~58 symbols
 * (ETFs, aliases, index tickers) bypassed the denylist entirely.
 */

const mockDbAll = vi.hoisted(() => vi.fn(async () => [] as Array<{ symbol: string }>));
vi.mock('../dbAsync', () => ({
  dbAll: mockDbAll,
  dbRun: vi.fn(async () => {}),
  dbGet: vi.fn(async () => undefined),
  dbExec: vi.fn(async () => {}),
}));

const bulkCalls = vi.hoisted(() => ({ current: [] as string[][] }));
vi.mock('../dbBulk', () => ({
  bulkUpsert: vi.fn(async (_tx: unknown, rows: string[][]) => {
    bulkCalls.current = rows;
    return { inserted: rows.length, failed: 0 };
  }),
  rowGroups: (n: number, _w: number) => Array.from({ length: n }, () => '(?)'),
}));

vi.mock('./stockMapping', () => ({ getAllStocks: () => [], getStockMapping: async () => ({}) }));
vi.mock('../services/marketService', () => ({ MarketData: class {} }));
vi.mock('./mcApiService', () => ({ mcFetchJson: vi.fn() }));
vi.mock('../data/nseStocks', () => ({ nseStocksData: [] }));
vi.mock('./cacheService', () => ({ cacheGet: async () => null, cacheSet: vi.fn() }));
vi.mock('./marketStatusService', () => ({ isMarketOpen: vi.fn(async () => false), isTradingHolidayToday: vi.fn(async () => false) }));
vi.mock('./intradayBreadth', () => ({ persistIntradayBreadth: vi.fn(async () => {}) }));
vi.mock('./yahooQuoteUrl', () => ({ yahooQuoteUrl: '' }));

import {
  persistTodayOHLCVData,
  getPostExitSymbols,
  getCanonicalSymbols,
  _resetPostExitCacheForTests,
  _resetCanonicalCacheForTests,
} from '../liveStockData';

const md = (symbol: string) =>
  ({
    symbol, name: symbol, price: 100, open: 99, high: 101, low: 98,
    change: 1, changePct: 1.01, volume: '10K', prevClose: 99,
  }) as any;

describe('persistTodayOHLCVData drops post-exit symbols (AF-20260914-05)', () => {
  beforeEach(() => {
    bulkCalls.current = [];
    mockDbAll.mockReset();
    mockDbAll.mockImplementation(async () => [] as Array<{ symbol: string }>);
    _resetPostExitCacheForTests();
    _resetCanonicalCacheForTests();
  });

  it('writes every row when no symbol is post-exit', async () => {
    // Call 1: getCanonicalSymbols() -> all symbols in universe (fail-open: empty set allows all)
    // Call 2: getPostExitSymbols() -> no dead symbols
    mockDbAll.mockResolvedValue([]);
    const res = await persistTodayOHLCVData([md('RELIANCE'), md('TCS')]);
    expect(res.inserted).toBe(2);
    expect(bulkCalls.current.map(r => r[0]).sort()).toEqual(['RELIANCE', 'TCS']);
  });

  it('drops a symbol whose exchange record shows no trades for >7 days', async () => {
    // Call 1: getCanonicalSymbols() -> both symbols in the master (so neither is dropped by allowlist)
    // Call 2: getPostExitSymbols() -> JETAIRWAYS is post-exit
    mockDbAll
      .mockResolvedValueOnce([{ symbol: 'RELIANCE' }, { symbol: 'JETAIRWAYS' }])  // canonical
      .mockResolvedValueOnce([{ symbol: 'JETAIRWAYS' }]);                          // post-exit
    const res = await persistTodayOHLCVData([md('RELIANCE'), md('JETAIRWAYS')]);
    expect(res.inserted).toBe(1);
    expect(bulkCalls.current.map(r => r[0])).toEqual(['RELIANCE']);
  });

  it('caches the dead set: a second persist does not re-query', async () => {
    // Call 1: getCanonicalSymbols() -> both symbols in master
    // Call 2: getPostExitSymbols() -> SRTRANSFIN is post-exit
    mockDbAll
      .mockResolvedValueOnce([{ symbol: 'RELIANCE' }, { symbol: 'SRTRANSFIN' }])  // canonical
      .mockResolvedValueOnce([{ symbol: 'SRTRANSFIN' }]);                          // post-exit
    await persistTodayOHLCVData([md('RELIANCE'), md('SRTRANSFIN')]);
    const callsAfterFirst = mockDbAll.mock.calls.length;
    await persistTodayOHLCVData([md('RELIANCE'), md('SRTRANSFIN')]);
    expect(mockDbAll.mock.calls.length).toBe(callsAfterFirst);
    // And the cached set still filters.
    expect(bulkCalls.current.map(r => r[0])).toEqual(['RELIANCE']);
  });

  it('getPostExitSymbols returns the queried set', async () => {
    mockDbAll.mockResolvedValue([{ symbol: 'GUJGASLTD' }]);
    const set = await getPostExitSymbols();
    expect(set.has('GUJGASLTD')).toBe(true);
  });
});

describe('persistTodayOHLCVData canonical universe allowlist (AF-20260915-10)', () => {
  beforeEach(() => {
    bulkCalls.current = [];
    mockDbAll.mockReset();
    mockDbAll.mockImplementation(async () => [] as Array<{ symbol: string }>);
    _resetPostExitCacheForTests();
    _resetCanonicalCacheForTests();
  });

  it('drops symbols not in nse_stocks when canonical set is populated', async () => {
    // First call: getCanonicalSymbols() -> SELECT symbol FROM nse_stocks
    // Second call: getPostExitSymbols() -> SELECT symbol FROM (... nse_universe_history ...)
    let callCount = 0;
    mockDbAll.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [{ symbol: 'RELIANCE' }, { symbol: 'TCS' }]; // nse_stocks
      return []; // no post-exit symbols
    });
    const res = await persistTodayOHLCVData([md('RELIANCE'), md('NIFTY50'), md('TCS')]);
    expect(res.inserted).toBe(2);
    expect(bulkCalls.current.map(r => r[0]).sort()).toEqual(['RELIANCE', 'TCS']);
  });

  it('allows all symbols through when getCanonicalSymbols fails (fail-open)', async () => {
    let callCount = 0;
    mockDbAll.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('nse_stocks unreachable');
      return []; // no post-exit symbols
    });
    const res = await persistTodayOHLCVData([md('RELIANCE'), md('NIFTY50')]);
    // Fail-open: both symbols pass through
    expect(res.inserted).toBe(2);
  });

  it('getCanonicalSymbols returns the queried set', async () => {
    mockDbAll.mockResolvedValue([{ symbol: 'RELIANCE' }, { symbol: 'TCS' }]);
    const set = await getCanonicalSymbols();
    expect(set.has('RELIANCE')).toBe(true);
    expect(set.has('TCS')).toBe(true);
    expect(set.has('NIFTY50')).toBe(false);
  });
});