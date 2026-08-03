import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const dbModule = await import('../db');
const db = dbModule.default;
const { qualityOversoldScanner } = await import('../strategySignalsService');

beforeEach(() => {
  // etnow_screener_stocks FK-references etnow_screeners -- delete the child first.
  ['etnow_screener_stocks', 'etnow_screeners', 'unified_signals', 'stock_scores']
    .forEach(table => db.exec(`DELETE FROM ${table}`));
});

// technical_analysis_signals folded into unified_signals (signal_source='technical',
// Cluster B-lite, 2026-08) -- rsi now lives in technical_score. qualityOversoldScanner was
// the highest-risk repoint since it filters numerically (rsi <= ?); a formatted text blob
// would not have been queryable this way.
describe('qualityOversoldScanner reads unified_signals.technical_score (formerly technical_analysis_signals.rsi)', () => {
  it('filters on the folded technical_score column', async () => {
    db.prepare(`INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-79', 'Zero Debt')`).run();
    db.prepare(`INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-79', 'INFY')`).run();
    db.prepare(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('INFY', date('now'), 'technical', 'Bullish', 28.5, 'ACTIVE', datetime('now'))`).run();
    db.prepare(`INSERT INTO stock_scores (symbol, timeframe, score, classification, negative_count)
      VALUES ('INFY', 'long_term', 55, 'Buy', 0)`).run();

    const rows = await qualityOversoldScanner(35, 65);

    const infy = rows.find(r => r.symbol === 'INFY');
    expect(infy).toBeDefined();
    expect(infy!.rsi).toBe(28.5);
  });

  it('excludes symbols above the RSI threshold', async () => {
    db.prepare(`INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-79', 'Zero Debt')`).run();
    db.prepare(`INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-79', 'TCS')`).run();
    db.prepare(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('TCS', date('now'), 'technical', 'Bearish', 70.0, 'ACTIVE', datetime('now'))`).run();
    db.prepare(`INSERT INTO stock_scores (symbol, timeframe, score, classification, negative_count)
      VALUES ('TCS', 'long_term', 55, 'Buy', 0)`).run();

    const rows = await qualityOversoldScanner(35, 65);

    expect(rows.find(r => r.symbol === 'TCS')).toBeUndefined();
  });

  it('uses the latest technical row when multiple signal_types exist for the same symbol/day', async () => {
    db.prepare(`INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-79', 'Zero Debt')`).run();
    db.prepare(`INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-79', 'WIPRO')`).run();
    // Older row (would have been overwritten under the old single-row-per-symbol PK, but the
    // widened 4-col key allows both to coexist -- the reader must pick the newer one.
    db.prepare(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('WIPRO', date('now'), 'technical', 'Neutral', 50.0, 'ACTIVE', '2020-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('WIPRO', date('now'), 'technical', 'Bullish', 25.0, 'ACTIVE', datetime('now'))`).run();
    db.prepare(`INSERT INTO stock_scores (symbol, timeframe, score, classification, negative_count)
      VALUES ('WIPRO', 'long_term', 55, 'Buy', 0)`).run();

    const rows = await qualityOversoldScanner(35, 65);

    expect(rows.find(r => r.symbol === 'WIPRO')?.rsi).toBe(25.0);
  });
});
