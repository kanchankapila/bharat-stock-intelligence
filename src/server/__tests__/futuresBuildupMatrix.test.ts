import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

// AF-20260930-41: the Decision Matrix "OI Build-Up" panel showed hard-coded tickers
// (RELIANCE, HAL, TATASTEEL ...). It now reads stock_futures_oi_history (MoneyControl FUTSTK).
async function row(symbol: string, date: string, expiry: string, buildup: string, pct: number) {
  await dbRun(
    `INSERT INTO stock_futures_oi_history
       (source, symbol, date, expiry, open_interest, oi_change, oi_pct_change, oi_buildup, futures_price, fetched_at)
     VALUES ('moneycontrol', ?, ?, ?, 1000, 10, ?, ?, 100, '2026-09-29T16:00:00')`,
    [symbol, date, expiry, pct, buildup],
  );
}

describe('getFuturesBuildupMatrix', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM stock_futures_oi_history`);
    await row('OLDDAY', '2026-09-28', '2026-10-27', 'Long Buildup', 99);        // older date: excluded
    await row('AAA', '2026-09-29', '2026-10-27', 'Long Buildup', 5);
    await row('AAA', '2026-09-29', '2026-11-24', 'Short Buildup', 50);          // far month: ignored
    await row('BBB', '2026-09-29', '2026-10-27', 'Long Buildup', -12);          // |12| > |5|
    await row('CCC', '2026-09-29', '2026-10-27', 'Short Covering', -3);
    await row('DDD', '2026-09-29', '2026-10-27', 'Long Unwinding', -8);
  });

  it('returns the latest date, near-month only, bucketed and ranked by |OI % change|', async () => {
    const m = await caller.getFuturesBuildupMatrix({ perBucket: 5 });
    expect(m.asOf).toBe('2026-09-29');
    expect(m.buckets['Long Buildup'].map((r: any) => r.symbol)).toEqual(['BBB', 'AAA']);
    expect(m.buckets['Short Buildup']).toEqual([]);
    expect(m.buckets['Short Covering'].map((r: any) => r.symbol)).toEqual(['CCC']);
    expect(m.buckets['Long Unwinding'].map((r: any) => r.symbol)).toEqual(['DDD']);
    expect(JSON.stringify(m)).not.toContain('OLDDAY');
  });

  it('ignores expiring-contract rows (expiry = session date) and falls back to the last valid session', async () => {
    // AF-20260930-44: on expiry day the fetcher stored the expiring contract with oi_change 0.
    await row('EXPDAY', '2026-09-30', '2026-09-30', 'Long Buildup', 0);
    const m = await caller.getFuturesBuildupMatrix({ perBucket: 5 });
    expect(m.asOf).toBe('2026-09-29');
    expect(JSON.stringify(m)).not.toContain('EXPDAY');
  });

  it('is honest when the table is empty', async () => {
    await dbRun(`DELETE FROM stock_futures_oi_history`);
    const m = await caller.getFuturesBuildupMatrix({ perBucket: 5 });
    expect(m.asOf).toBeNull();
    expect(Object.values(m.buckets).every((b: any) => b.length === 0)).toBe(true);
  });
});
