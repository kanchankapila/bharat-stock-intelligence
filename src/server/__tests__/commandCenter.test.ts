import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
const { default: db } = await import('../db');

import { createCallerFactory } from '../trpc';

// Import router after DB is set up
const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

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
