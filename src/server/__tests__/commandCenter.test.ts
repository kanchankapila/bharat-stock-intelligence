import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';

// Import router after DB is set up
const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);
const { invalidateUrLatestAt } = await import('../routers/commandCenter.router');

// `information_schema.columns`, not SQLite's `PRAGMA table_info`. These two cases assert the
// real production shape now that the suite runs against a throwaway Postgres schema built from
// db/schema.postgres.sql -- previously they asserted db.ts's SQLite schema-of-record, which
// recurring-bugs.md records as "not authoritative" and which was measurably wrong for at least
// one table (timeframe_scores, fixed the same day this suite was converted).
const columnsOf = async (table: string) =>
  (await dbAll<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ?`,
    [table],
  )).map(r => r.column_name);

describe('DB schema — unified_recommendations', () => {
  it('table exists with required columns', async () => {
    const cols = await columnsOf('unified_recommendations');
    for (const c of [
      'symbol', 'computed_at', 'regime', 'unified_score', 'conviction_level',
      'screener_stock_score', 'ml_score', 'confluence_score', 'technical_score', 'dl_score',
      'bullish_screener_count', 'bearish_screener_count', 'entry_zone_low', 'stop_loss',
      'target_1', 'risk_reward', 'timeframe', 'sector',
    ]) {
      expect(cols, `unified_recommendations.${c}`).toContain(c);
    }
  });

  it('screener_catalog table exists with required columns', async () => {
    const cols = await columnsOf('screener_catalog');
    for (const c of [
      'screener_id', 'source', 'screener_name', 'category', 'subcategory', 'signal_bias',
      'confidence', 'investment_horizon', 'score_0_100', 'tier', 'sub_mod', 'horiz_mult',
    ]) {
      expect(cols, `screener_catalog.${c}`).toContain(c);
    }
  });

  it('unique constraint on (symbol, computed_at)', async () => {
    await dbExec(`DELETE FROM unified_recommendations`);
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('TEST', '2026-06-01', 'BULL', 75.0, 'A_HIGH')`);
    // The upsert must be accepted, i.e. the (symbol, computed_at) constraint really exists --
    // ON CONFLICT raises "no unique or exclusion constraint matching" if it does not.
    await expect(dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('TEST', '2026-06-01', 'BULL', 80.0, 'A_HIGH')
      ON CONFLICT (symbol, computed_at) DO UPDATE SET unified_score = excluded.unified_score`),
    ).resolves.toBeTruthy();
    const row = await dbGet<any>("SELECT unified_score FROM unified_recommendations WHERE symbol='TEST'");
    expect(row.unified_score).toBe(80.0);
  });
});

describe('getCommandCenter', () => {
  beforeEach(async () => {
    await dbExec(`DELETE FROM unified_recommendations`);
    await dbExec(`DELETE FROM market_regimes`);
  });

  it('returns empty eodPicks when no data', async () => {
    const result = await caller.getCommandCenter({});
    expect(result).toHaveProperty('eodPicks');
    expect(result).toHaveProperty('intradaySignals');
    expect(result).toHaveProperty('regime');
    expect(Array.isArray(result.eodPicks)).toBe(true);
  });

  it('filters by conviction level', async () => {
    await dbRun(`INSERT INTO market_regimes (date, regime, regime_prob) VALUES (CURRENT_DATE,'BULL',0.8)`);
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('ELITE_STOCK', CURRENT_DATE, 'BULL', 90.0, 'S_ELITE')`);
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES ('LOW_STOCK', CURRENT_DATE, 'BULL', 30.0, 'C_LOW')`);

    const elite = await caller.getCommandCenter({ conviction: 'S_ELITE' });
    expect(elite.eodPicks.length).toBe(1);
    expect(elite.eodPicks[0].symbol).toBe('ELITE_STOCK');
  });

  it('returns regime object with name and confidence', async () => {
    await dbRun(`INSERT INTO market_regimes (date, regime, regime_prob) VALUES (CURRENT_DATE,'BEAR',0.75)`);
    const result = await caller.getCommandCenter({});
    expect(result.regime.name).toBe('BEAR');
    expect(result.regime.confidence).toBe(0.75);
  });
});

describe('getBuyRecommendations', () => {
  beforeEach(async () => {
    await dbExec(`DELETE FROM unified_recommendations`);
    await dbExec(`DELETE FROM market_regimes`);
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
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('TOPSELL', ?, 'BULL', 99.0, 'S_ELITE', 'Sell')`, [ts]);
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('REALBUY', ?, 'BULL', 50.0, 'A_HIGH', 'Buy')`, [ts]);

    const result = await caller.getBuyRecommendations({ conviction: 'ALL' });
    const symbols = result.picks.map((p: any) => p.symbol);
    expect(symbols).not.toContain('TOPSELL');
    expect(symbols).toContain('REALBUY');
  });

  it("'TOP' conviction (the default) includes S_ELITE and A_HIGH, excludes B_MEDIUM", async () => {
    const ts = '2026-08-03T00:00:00.000Z';
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('ELITE_BUY', ?, 'BULL', 90.0, 'S_ELITE', 'Strong Buy')`, [ts]);
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('HIGH_BUY', ?, 'BULL', 80.0, 'A_HIGH', 'Buy')`, [ts]);
    await dbRun(`INSERT INTO unified_recommendations
      (symbol, computed_at, regime, unified_score, conviction_level, classification)
      VALUES ('MEDIUM_BUY', ?, 'BULL', 70.0, 'B_MEDIUM', 'Buy')`, [ts]);

    const result = await caller.getBuyRecommendations({ conviction: 'TOP' });
    const symbols = result.picks.map((p: any) => p.symbol);
    expect(symbols).toContain('ELITE_BUY');
    expect(symbols).toContain('HIGH_BUY');
    expect(symbols).not.toContain('MEDIUM_BUY');
  });
});

describe('getIntradayTopPicks', () => {
  beforeEach(async () => {
    await dbExec(`DELETE FROM intraday_recommendations`);
  });

  it('returns an explicit closed-gate state (not an empty/loading-looking list) when the emission gate is closed', async () => {
    const today = '2026-08-03';
    await dbRun(`INSERT INTO intraday_recommendations
      (symbol, computed_at, intraday_regime, intraday_score, conviction_level, classification, reasoning)
      VALUES ('GATEDSTOCK', ?, 'NEUTRAL', 70.0, 'A_HIGH', 'Hold',
              '2 bullish / 0 bearish intraday screeners (Hold); regime NEUTRAL; EMISSION GATED (engine''s trailing realised edge is not positive)')`, [today]);

    const result = await caller.getIntradayTopPicks();
    expect(result.gateOpen).toBe(false);
    expect(result.gateReason).toBeTruthy();
    expect(result.picks.length).toBe(0);
    expect(result.totalScored).toBe(1);
  });

  it('returns actionable picks when the gate is open', async () => {
    const today = '2026-08-03';
    await dbRun(`INSERT INTO intraday_recommendations
      (symbol, computed_at, intraday_regime, intraday_score, conviction_level, classification, reasoning)
      VALUES ('OPENSTOCK', ?, 'RISK_ON', 85.0, 'S_ELITE', 'Strong Buy',
              '3 bullish / 0 bearish intraday screeners (Strong Buy); regime RISK_ON')`, [today]);

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
