import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

beforeEach(async () => {
  await dbExec('DELETE FROM stock_ohlcv');
});

describe('getRecentCloseSeries', () => {
  it('returns ascending closes per symbol, most recent N days only', async () => {
    const insert = 'INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const dates = ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'];
    for (const [i, d] of dates.entries()) {
      await dbRun(insert, ['TEST', d, 100, 105, 99, 100 + i, 1000]);
    }

    const result = await caller.getRecentCloseSeries({ symbols: ['TEST'], days: 3 });
    expect(result.TEST).toEqual([102, 103, 104]); // last 3 days, ascending
  });

  it('excludes suspect (bad-print) bars', async () => {
    const insert = 'INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, is_suspect) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    await dbRun(insert, ['TEST', '2026-01-01', 100, 105, 99, 100, 1000, 0]);
    await dbRun(insert, ['TEST', '2026-01-02', 100, 105, 99, 99999, 1000, 1]); // fabricated spike, flagged suspect

    const result = await caller.getRecentCloseSeries({ symbols: ['TEST'], days: 10 });
    expect(result.TEST).toEqual([100]);
  });

  it('returns an empty object for an empty symbol list', async () => {
    const result = await caller.getRecentCloseSeries({ symbols: [], days: 10 });
    expect(result).toEqual({});
  });

  it('omits symbols with no OHLCV history rather than inventing data', async () => {
    const result = await caller.getRecentCloseSeries({ symbols: ['NOTHING'], days: 10 });
    expect(result.NOTHING).toBeUndefined();
  });

  it('keeps series independent across multiple symbols', async () => {
    const insert = 'INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await dbRun(insert, ['AAA', '2026-01-01', 10, 11, 9, 10, 1000]);
    await dbRun(insert, ['AAA', '2026-01-02', 10, 11, 9, 11, 1000]);
    await dbRun(insert, ['BBB', '2026-01-01', 50, 51, 49, 50, 1000]);

    const result = await caller.getRecentCloseSeries({ symbols: ['AAA', 'BBB'], days: 10 });
    expect(result.AAA).toEqual([10, 11]);
    expect(result.BBB).toEqual([50]);
  });
});
