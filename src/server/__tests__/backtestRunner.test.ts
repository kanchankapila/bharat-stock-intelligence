import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES (dbAsync.ts's usePostgres()
// reads it fresh on every call, not just at import time) -- without this, a real dev/CI
// environment with USE_POSTGRES=true routes every dbAsync call to a live Postgres pool
// instead of the in-memory SQLite `db` this file sets up and populates directly, and the
// test fails on ECONNREFUSED regardless of what it's actually testing. Must be set before
// any (even transitive) import of dbAsync.ts/pgConfig.ts -- see the dynamic `await import`
// below, which exists specifically so these env vars land first.
process.env.USE_POSTGRES = 'false';
const dbModule = await import('../db');
const db = dbModule.default;
const backtestModule = await import('../backtestRunner');
const { runBacktest } = backtestModule;
await import('../scoringService');

beforeEach(() => {
  ['screener_runs', 'timeframe_scores', 'quant_scores', 'technical_composite_scores', 'stock_fundamentals', 'stock_ohlcv', 'backtesting_runs']
    .forEach(table => db.exec(`DELETE FROM ${table}`));
});

describe('backtestRunner', () => {
  it('runs a backtest using next-day open entry and horizon exit after costs', async () => {
    db.prepare('INSERT INTO screener_runs (run_id, screener_id, run_ts, records_json) VALUES (?, ?, ?, ?)')
      .run('run2', 'S456', '2025-01-01T00:00:00Z', JSON.stringify([{ symbol: 'TEST' }]));

    db.prepare('INSERT INTO quant_scores (symbol, return_1w, return_1m, momentum_score, rank_momentum) VALUES (?, ?, ?, ?, ?)')
      .run('TEST', 1.2, 3.5, 60, 70);
    db.prepare('INSERT INTO technical_composite_scores (symbol, composite_score) VALUES (?, ?)')
      .run('TEST', 55);
    db.prepare('INSERT INTO stock_fundamentals (symbol, trailing_pe, return_on_equity, avg_volume_3m, market_cap) VALUES (?, ?, ?, ?, ?)')
      .run('TEST', 20.3, 0.16, 450000, 7200000000);
    db.prepare('INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('TEST', '2025-01-02', 100, 101, 99, 101, 1200000);
    db.prepare('INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('TEST', '2025-01-03', 102, 103, 101, 105, 1100000);

    const result = await runBacktest({ runId: 'run2', timeframe: 'short', horizonDays: 1, topN: 5 });

    expect(result).toBeTruthy();
    expect(result.summary.total_trades).toBe(1);
    expect(result.summary.win_rate).toBe(1);
    expect(result.summary.avg_trade_return_pct).toBeGreaterThan(0);
    expect(result.summary.total_return_pct).toBeGreaterThan(0);

    const inserted = db.prepare('SELECT * FROM backtesting_runs WHERE id = ?').get(result.insertedId) as any;
    expect(inserted).toBeTruthy();
    expect(inserted.total_trades).toBe(1);
    expect(inserted.trades || inserted.total_trades).toBe(1);
  });
});
