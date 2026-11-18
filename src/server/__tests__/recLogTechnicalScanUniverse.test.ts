import { describe, it, expect, beforeEach } from 'vitest';

/**
 * AF-20261117-21: technicalSignalsService's recommendation_log insert had no tradeable-universe
 * filter (scoring_engine's writer has had one since 2026-08-01), so index symbols the scan covers
 * were logged as BUY recommendations (NIFTYIT 2026-11-11 and 11-13, NIFTYPHARMA 2026-11-17).
 * Runs the writer's real SQL against the vitest throwaway schema.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('recLogTechnicalScanUniverse.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbAll } = await import('../dbAsync');
const { REC_LOG_UPSERT_SQL } = await import('../technicalSignalsService');

const params = (symbol: string) => [
  symbol, '2026-11-17', 100, 95, 105, 110, 115, 6, 6, '[]', 'BULL', null, null, null, symbol,
];

describe('technical_scan recommendation_log insert', () => {
  beforeEach(async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".nse_stocks (
      symbol TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, instrument_type TEXT NOT NULL DEFAULT 'equity')`);
    await dbRun(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".recommendation_log (
      id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL, rec_type TEXT NOT NULL, signal_date DATE NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL, timeframe TEXT, entry_price DOUBLE PRECISION,
      stop_loss DOUBLE PRECISION, target_1 DOUBLE PRECISION, target_2 DOUBLE PRECISION,
      target_3 DOUBLE PRECISION, confidence_score DOUBLE PRECISION, signal_score BIGINT,
      signals_json TEXT, nifty_regime TEXT, win_probability DOUBLE PRECISION,
      quant_score DOUBLE PRECISION, sentiment_score DOUBLE PRECISION, source TEXT, status TEXT,
      horizon_days BIGINT)`);
    await dbRun(`DELETE FROM "${SCHEMA}".recommendation_log WHERE signal_date = '2026-11-17'`);
    await dbRun(`DELETE FROM "${SCHEMA}".nse_stocks WHERE symbol IN ('RSIEQ', 'RSIETF', 'RSIOLD')`);
    await dbRun(`INSERT INTO "${SCHEMA}".nse_stocks (symbol, name, status, instrument_type) VALUES
      ('RSIEQ', 'Eq', 'ACTIVE', 'equity'), ('RSIETF', 'Etf', 'ACTIVE', 'etf'),
      ('RSIOLD', 'Old', 'DELISTED', 'equity')`);
  });

  it('logs only active equities, never an index or other non-listing', async () => {
    for (const s of ['RSIEQ', 'NIFTYIT', 'RSIETF', 'RSIOLD']) await dbRun(REC_LOG_UPSERT_SQL, params(s));
    const rows = await dbAll<{ symbol: string }>(
      `SELECT symbol FROM "${SCHEMA}".recommendation_log WHERE signal_date = '2026-11-17' ORDER BY symbol`);
    expect(rows.map(r => r.symbol)).toEqual(['RSIEQ']);
  });
});
