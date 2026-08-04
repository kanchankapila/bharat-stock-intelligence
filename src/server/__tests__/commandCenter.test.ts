import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const { default: db } = await import('../db');

import { createCallerFactory } from '../trpc';

// Import router after DB is set up
const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);
const { invalidateUrLatestAt } = await import('../routers/commandCenter.router');

describe('DB schema — unified_recommendations', () => {
  it('table exists with required columns', () => {
    const info = db.prepare("PRAGMA table_info(unified_recommendations)").all() as any[];
    const cols = info.map((c: any) => c.name);
    expect(cols).toContain('symbol');
    expect(cols).toContain('computed_at');
    expect(cols).toContain('regime');
    expect(cols).toContain('unified_score');
    expect(cols).toContain('conviction_level');
    expect(cols).toContain('screener_stock_score');
    expect(cols).toContain('ml_score');
    expect(cols).toContain('confluence_score');
    expect(cols).toContain('technical_score');
    expect(cols).toContain('dl_score');
    expect(cols).toContain('bullish_screener_count');
    expect(cols).toContain('bearish_screener_count');
    expect(cols).toContain('entry_zone_low');
    expect(cols).toContain('stop_loss');
    expect(cols).toContain('target_1');
    expect(cols).toContain('risk_reward');
    expect(cols).toContain('timeframe');
    expect(cols).toContain('sector');
  });

  it('screener_catalog table exists with required columns', () => {
    const info = db.prepare("PRAGMA table_info(screener_catalog)").all() as any[];
    const cols = info.map((c: any) => c.name);
    expect(cols).toContain('screener_id');
    expect(cols).toContain('source');
    expect(cols).toContain('screener_name');
    expect(cols).toContain('category');
    expect(cols).toContain('subcategory');
    expect(cols).toContain('signal_bias');
    expect(cols).toContain('confidence');
    expect(cols).toContain('investment_horizon');
    expect(cols).toContain('score_0_100');
    expect(cols).toContain('tier');
    expect(cols).toContain('sub_mod');
    expect(cols).toContain('horiz_mult');
  });

  it('unique constraint on (symbol, computed_at)', () => {
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('TEST', '2026-06-01', 'BULL', 75.0, 'A_HIGH')`).run();
    expect(() => db.prepare(`INSERT OR REPLACE INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('TEST', '2026-06-01', 'BULL', 80.0, 'A_HIGH')`).run()
    ).not.toThrow();
    const row: any = db.prepare(
      "SELECT unified_score FROM unified_recommendations WHERE symbol='TEST'"
    ).get();
    expect(row.unified_score).toBe(80.0);
  });
});

describe('getCommandCenter', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM unified_recommendations`);
    db.exec(`DELETE FROM market_regimes`);
  });

  it('returns empty eodPicks when no data', async () => {
    const result = await caller.getCommandCenter({});
    expect(result).toHaveProperty('eodPicks');
    expect(result).toHaveProperty('intradaySignals');
    expect(result).toHaveProperty('regime');
    expect(Array.isArray(result.eodPicks)).toBe(true);
  });

  it('filters by conviction level', async () => {
    db.prepare(`INSERT INTO market_regimes (date, regime, regime_prob) VALUES (date('now'),'BULL',0.8)`).run();
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('ELITE_STOCK', date('now'), 'BULL', 90.0, 'S_ELITE')`).run();
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('LOW_STOCK', date('now'), 'BULL', 30.0, 'C_LOW')`).run();

    const elite = await caller.getCommandCenter({ conviction: 'S_ELITE' });
    expect(elite.eodPicks.length).toBe(1);
    expect(elite.eodPicks[0].symbol).toBe('ELITE_STOCK');
  });

  it('returns regime object with name and confidence', async () => {
    db.prepare(`INSERT INTO market_regimes (date, regime, regime_prob) VALUES (date('now'),'BEAR',0.75)`).run();
    const result = await caller.getCommandCenter({});
    expect(result.regime.name).toBe('BEAR');
    expect(result.regime.confidence).toBe(0.75);
  });
});

describe('getBuyRecommendations', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM unified_recommendations`);
    db.exec(`DELETE FROM market_regimes`);
    // getBuyRecommendations resolves MAX(computed_at) through a 5-min module-level cache
    // shared with getCommandCenter -- without invalidating it here, a prior test's cached
    // timestamp leaks in and the WHERE ur.computed_at = ? filter matches nothing.
    invalidateUrLatestAt();
  });

  // Regression test for a real bug found 2026-08-03: this endpoint had no classification
  // filter at all, so a "Buy Recommendations" page could (and on live data, did) surface
  // Sell/Strong Sell/Hold rows ranked above real Buy picks whenever their unified_score
  // happened to be higher -- unified_score is a magnitude, not a signed direction.
  it('never returns a Sell/Strong Sell/Hold row, regardless of how high its score is', async () => {
    const ts = '2026-08-03T00:00:00.000Z';
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('TOPSELL', ?, 'BULL', 99.0, 'S_ELITE', 'Sell')`).run(ts);
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('REALBUY', ?, 'BULL', 50.0, 'A_HIGH', 'Buy')`).run(ts);

    const result = await caller.getBuyRecommendations({ conviction: 'ALL' });
    const symbols = result.picks.map((p: any) => p.symbol);
    expect(symbols).not.toContain('TOPSELL');
    expect(symbols).toContain('REALBUY');
  });

  it("'TOP' conviction (the default) includes S_ELITE and A_HIGH, excludes B_MEDIUM", async () => {
    const ts = '2026-08-03T00:00:00.000Z';
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('ELITE_BUY', ?, 'BULL', 90.0, 'S_ELITE', 'Strong Buy')`).run(ts);
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('HIGH_BUY', ?, 'BULL', 80.0, 'A_HIGH', 'Buy')`).run(ts);
    db.prepare(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('MEDIUM_BUY', ?, 'BULL', 70.0, 'B_MEDIUM', 'Buy')`).run(ts);

    const result = await caller.getBuyRecommendations({ conviction: 'TOP' });
    const symbols = result.picks.map((p: any) => p.symbol);
    expect(symbols).toContain('ELITE_BUY');
    expect(symbols).toContain('HIGH_BUY');
    expect(symbols).not.toContain('MEDIUM_BUY');
  });
});

describe('getIntradayTopPicks', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM intraday_recommendations`);
  });

  it('returns an explicit closed-gate state (not an empty/loading-looking list) when the emission gate is closed', async () => {
    const today = '2026-08-03';
    db.prepare(`INSERT INTO intraday_recommendations
      (symbol, computed_at, intraday_regime, intraday_score, conviction_level, classification, reasoning)
      VALUES ('GATEDSTOCK', ?, 'NEUTRAL', 70.0, 'A_HIGH', 'Hold',
              '2 bullish / 0 bearish intraday screeners (Hold); regime NEUTRAL; EMISSION GATED (engine''s trailing realised edge is not positive)')`)
      .run(today);

    const result = await caller.getIntradayTopPicks();
    expect(result.gateOpen).toBe(false);
    expect(result.gateReason).toBeTruthy();
    expect(result.picks.length).toBe(0);
    expect(result.totalScored).toBe(1);
  });

  it('returns actionable picks when the gate is open', async () => {
    const today = '2026-08-03';
    db.prepare(`INSERT INTO intraday_recommendations
      (symbol, computed_at, intraday_regime, intraday_score, conviction_level, classification, reasoning)
      VALUES ('OPENSTOCK', ?, 'RISK_ON', 85.0, 'S_ELITE', 'Strong Buy',
              '3 bullish / 0 bearish intraday screeners (Strong Buy); regime RISK_ON')`)
      .run(today);

    const result = await caller.getIntradayTopPicks();
    expect(result.gateOpen).toBe(true);
    expect(result.gateReason).toBeNull();
    expect(result.picks.map((p: any) => p.symbol)).toContain('OPENSTOCK');
  });

  it('returns a null gate state (not false) when nothing has been scored yet', async () => {
    const result = await caller.getIntradayTopPicks();
    expect(result.gateOpen).toBeNull();
    expect(result.picks).toEqual([]);
    expect(result.totalScored).toBe(0);
  });
});
