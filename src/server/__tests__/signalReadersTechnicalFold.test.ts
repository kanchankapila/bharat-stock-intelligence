import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
const { qualityOversoldScanner } = await import('../strategySignalsService');

beforeEach(async () => {
  // etnow_screener_stocks FK-references etnow_screeners -- delete the child first.
  for (const table of ['etnow_screener_stocks', 'etnow_screeners', 'unified_signals', 'stock_scores']) {

    await dbExec(`DELETE FROM ${table}`);

  }
});

// technical_analysis_signals folded into unified_signals (signal_source='technical',
// Cluster B-lite, 2026-08) -- rsi now lives in technical_score. qualityOversoldScanner was
// the highest-risk repoint since it filters numerically (rsi <= ?); a formatted text blob
// would not have been queryable this way.
describe('qualityOversoldScanner reads unified_signals.technical_score (formerly technical_analysis_signals.rsi)', () => {
  it('filters on the folded technical_score column', async () => {
    await dbRun(`INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-79', 'Zero Debt')`);
    await dbRun(`INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-79', 'INFY')`);
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('INFY', CURRENT_DATE, 'technical', 'Bullish', 28.5, 'ACTIVE', CURRENT_TIMESTAMP)`);
    await dbRun(`INSERT INTO stock_scores (symbol, timeframe, score, classification, negative_count)
      VALUES ('INFY', 'long_term', 55, 'Buy', 0)`);

    const rows = await qualityOversoldScanner(35, 65);

    const infy = rows.find(r => r.symbol === 'INFY');
    expect(infy).toBeDefined();
    expect(infy!.rsi).toBe(28.5);
  });

  it('excludes symbols above the RSI threshold', async () => {
    await dbRun(`INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-79', 'Zero Debt')`);
    await dbRun(`INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-79', 'TCS')`);
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('TCS', CURRENT_DATE, 'technical', 'Bearish', 70.0, 'ACTIVE', CURRENT_TIMESTAMP)`);
    await dbRun(`INSERT INTO stock_scores (symbol, timeframe, score, classification, negative_count)
      VALUES ('TCS', 'long_term', 55, 'Buy', 0)`);

    const rows = await qualityOversoldScanner(35, 65);

    expect(rows.find(r => r.symbol === 'TCS')).toBeUndefined();
  });

  it('uses the latest technical row when multiple signal_types exist for the same symbol/day', async () => {
    await dbRun(`INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-79', 'Zero Debt')`);
    await dbRun(`INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-79', 'WIPRO')`);
    // Older row (would have been overwritten under the old single-row-per-symbol PK, but the
    // widened 4-col key allows both to coexist -- the reader must pick the newer one.
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('WIPRO', CURRENT_DATE, 'technical', 'Neutral', 50.0, 'ACTIVE', '2020-01-01T00:00:00.000Z')`);
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, technical_score, status, signal_generated_at)
      VALUES ('WIPRO', CURRENT_DATE, 'technical', 'Bullish', 25.0, 'ACTIVE', CURRENT_TIMESTAMP)`);
    await dbRun(`INSERT INTO stock_scores (symbol, timeframe, score, classification, negative_count)
      VALUES ('WIPRO', 'long_term', 55, 'Buy', 0)`);

    const rows = await qualityOversoldScanner(35, 65);

    expect(rows.find(r => r.symbol === 'WIPRO')?.rsi).toBe(25.0);
  });
});
