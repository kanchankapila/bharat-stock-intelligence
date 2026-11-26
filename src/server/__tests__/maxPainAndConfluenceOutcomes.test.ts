import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { dbExec, dbRun } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';
import { cacheDel } from '../cacheService';

const { appRouter } = await import('../router');
const caller = createCallerFactory(appRouter)({} as any);

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const block = (file: string, name: string) => {
  const src = readFileSync(join(__dirname, '..', 'routers', file), 'utf8');
  const start = src.indexOf(`${name}: publicProcedure`);
  return src.slice(start, src.indexOf('Procedure', start + name.length + 20));
};

// AF-20261126-01: getMaxPainAlerts windowed ROW_NUMBER over every stock_ohlcv bar (2.8M) on each call,
// uncached, from three components; two such statements were seen running 100-200 s on 2026-11-26.
describe('getMaxPainAlerts', () => {
  beforeEach(async () => {
    await dbExec(`CREATE TABLE IF NOT EXISTS so_stock_oi_summary (
      symbol TEXT NOT NULL, date DATE NOT NULL, expiry TEXT NOT NULL, max_pain DOUBLE PRECISION,
      pcr DOUBLE PRECISION, mwpl DOUBLE PRECISION, PRIMARY KEY (symbol, date, expiry))`);
    await dbExec('DELETE FROM so_stock_oi_summary');
    await dbExec("DELETE FROM stock_ohlcv WHERE symbol IN ('MPA','MPB','MPC')");
    await cacheDel('fno:max_pain_alerts');
  });

  const oi = (s: string, d: string, e: string, mp: number) =>
    dbRun('INSERT INTO so_stock_oi_summary (symbol, date, expiry, max_pain) VALUES (?,?,?,?)', [s, d, e, mp]);
  const bar = (s: string, d: string, c: number) =>
    dbRun('INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)', [s, d, c, c, c, c, 1000]);

  it('uses the nearest expiry of the latest OI date and the latest recent close', async () => {
    await oi('MPA', day(8), '2026-12-30', 50);
    await oi('MPA', day(2), '2026-12-30', 90);
    await oi('MPA', day(2), '2027-01-27', 200);
    await bar('MPA', day(9), 80);
    await bar('MPA', day(2), 100);
    // A close more than a month old is not a current price; such a symbol is left out.
    await oi('MPC', day(2), '2026-12-30', 40);
    await bar('MPC', day(60), 100);
    const rows = await caller.getMaxPainAlerts();
    expect(rows.map(r => r.symbol)).toEqual(['MPA']);
    expect(rows[0]).toMatchObject({ ltp: 100, maxPain: 90, diffPct: 10 });
  });

  it('reads stock_ohlcv per symbol inside a date bound, and is cached', () => {
    const sql = block('fno.router.ts', 'getMaxPainAlerts');
    expect(sql).toMatch(/JOIN LATERAL/i);
    expect(sql).toMatch(/FROM stock_ohlcv\s+\w+\s+WHERE\s+\w+\.symbol\s*=\s*n\.symbol\s+AND\s+\w+\.date\s*>=/i);
    expect(sql).not.toMatch(/PARTITION BY symbol ORDER BY date DESC[\s\S]{0,60}FROM stock_ohlcv/i);
    expect(sql).toContain('fetchWithCache');
  });
});

// AF-20261126-02: the unfiltered branch nested-looped ~960k outcomes against ~6.5M confluence rows.
describe('getConfluenceOutcomes', () => {
  beforeEach(async () => {
    await dbExec("DELETE FROM signal_outcomes WHERE symbol IN ('COA','COB')");
    await dbExec("DELETE FROM confluence_signals WHERE symbol IN ('COA','COB')");
  });

  const outcome = (s: string, d: string) => dbRun(
    `INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, signal_source) VALUES (?,?,5,100,'confluence')`, [s, d]);
  const signal = (s: string, at: string, level: string) => dbRun(
    `INSERT INTO confluence_signals (symbol, computed_at, confluence_score, conviction_level, active_screener_count,
       bullish_screener_count, bearish_screener_count, screener_ids_json, screener_names_json, screener_weights_json)
     VALUES (?,?,50,?,1,1,0,'[]','[]','[]')`, [s, at, level]);

  it('returns one row per outcome, newest first, with that day\'s latest conviction', async () => {
    await outcome('COA', '2026-11-20');
    await outcome('COA', '2026-11-24');
    await outcome('COB', '2026-11-25');
    await signal('COA', '2026-11-24T04:00:00Z', 'MODERATE');
    await signal('COA', '2026-11-24T10:00:00Z', 'STRONG');
    const rows: any[] = await caller.getConfluenceOutcomes({ symbol: 'COA' });
    expect(rows.map(r => [String(r.signal_date).slice(0, 10), r.conviction_level])).toEqual([
      ['2026-11-24', 'STRONG'], ['2026-11-20', null],
    ]);
  });

  it('limits the outcomes before joining confluence_signals', () => {
    const sql = block('confluence.router.ts', 'getConfluenceOutcomes');
    expect(sql).toMatch(/LIMIT \?\s*\)\s*so\s+LEFT JOIN LATERAL/i);
  });
});
