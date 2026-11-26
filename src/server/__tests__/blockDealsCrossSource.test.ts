import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const caller = createCallerFactory(appRouter)({} as any);

// AF-20261126-04: MoneyControl's history fetcher and NSE's daily file re-report deals that Tickertape
// already stored, so the deals list showed the same trade two or three times.
beforeEach(async () => {
  await dbExec(`CREATE TABLE IF NOT EXISTS block_deals (
    id TEXT PRIMARY KEY, symbol TEXT, date TEXT, session TEXT, qty BIGINT, price REAL, value_cr REAL,
    fetched_at TEXT, pct_transacted REAL, client_name TEXT, trade_type TEXT, category TEXT, source TEXT)`);
  await dbExec("DELETE FROM block_deals WHERE symbol = 'BDX'");
});

const deal = (id: string, date: string, qty: number, side: string | null, source: string) => dbRun(
  `INSERT INTO block_deals (id, symbol, date, qty, price, value_cr, trade_type, source) VALUES (?, 'BDX', ?, ?, 100, 1, ?, ?)`,
  [id, date, qty, side, source]);

describe('getBlockDeals', () => {
  it('lists each trade once across sources, keeping distinct same-size trades', async () => {
    await deal('t1', '2026-11-20', 100, 'buy', 'tickertape');
    await deal('t2', '2026-11-20', 100, 'buy', 'tickertape');
    await deal('m1', '2026-11-20', 100, 'BUY', 'moneycontrol');
    await deal('n1', '2026-11-20', 100, null, 'nse');
    await deal('m2', '2026-11-19', 40, 'BUY', 'moneycontrol');
    const rows: any[] = await caller.getBlockDeals({ symbol: 'BDX' });
    expect(rows.map(r => [String(r.date).slice(0, 10), Number(r.qty)])).toEqual([
      ['2026-11-20', 100], ['2026-11-20', 100], ['2026-11-19', 40],
    ]);
  });
});
