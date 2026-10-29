/**
 * Monitoring probes must be answerable from an index or a bounded chunk range.
 *
 * Measured 2026-10-28 (pg_stat_statements since the 10-26 restart): the freshness/status probes
 * were the heaviest load on the database — signal_outcomes MAX/COUNT 16.7s x 412 calls each,
 * feature_store MAX(computed_at) 51s, DISTINCT stock_ohlcv dates 4.9s,
 * niftytrader_live_screener_snapshots MAX(captured_at) 47s, technical_signal_observations
 * MAX(recorded_at::text) 45s although recorded_at HAS an index (the cast inside MAX defeats it).
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => undefined),
  dbAll: vi.fn(async () => []),
  dbRun: vi.fn(async () => {}),
  dbExec: vi.fn(async () => {}),
}));

import { DATA_QUALITY_CHECKS } from '../dataQualityChecks';

const serverDir = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.resolve(serverDir, rel), 'utf8');

describe('monitoring probes are index-friendly', () => {
  it('no data-quality check casts a column inside MAX() (MAX(col)::text keeps the index usable)', () => {
    const offenders = DATA_QUALITY_CHECKS
      .filter(c => /MAX\(\s*[\w."]+::text\s*\)/i.test(c.sql))
      .map(c => c.id);
    expect(DATA_QUALITY_CHECKS.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it('probes that scan a non-time column of a big daily table are bounded by date', () => {
    const lines = [read('jobHeartbeat.ts'), read('routers/monitor.router.ts')]
      .flatMap(src => src.split('\n'))
      .filter(l => /FROM (stock_ohlcv|feature_store|technical_signals)\b/.test(l))
      .filter(l => /DISTINCT|MAX\(computed_at\)/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.filter(l => !/WHERE date >=? /.test(l)).map(l => l.trim())).toEqual([]);
  });

  it('the schema indexes every column a hot freshness/status probe aggregates', () => {
    const schema = fs.readFileSync(path.resolve(serverDir, '..', '..', 'db', 'schema.postgres.sql'), 'utf8');
    const indexed = (table: string, cols: string[]) =>
      new RegExp(`ON public\\.${table} USING btree \\(${cols.map(c => `"?${c}"?`).join('(?: DESC)?, ')}(?: DESC)?[,)]`).test(schema);
    const required: Array<[string, string[]]> = [
      ['signal_outcomes', ['signal_source', 'horizon_days', 'computed_at']],
      ['niftytrader_live_screener_snapshots', ['captured_at']],
      ['technical_signal_observations', ['recorded_at']],
      ['investsights_factor_scores', ['fetched_date']],
      ['mc_general_metrics', ['source_api', 'fetched_at']],
      ['marketsmojo_financials_history', ['fetched_at']],
      ['mover_snapshots', ['trade_date']],
      ['trendlyne_pb_history', ['fetched_at']],
      ['trendlyne_pe_history', ['fetched_at']],
      ['market_decision_evidence', ['available_at']],
      ['live_screener_ml_scores', ['computed_at']],
      ['news_articles', ['timestamp']],
      ['investsights_fundamentals_history', ['fetched_date']],
      ['market_decision_event', ['created_at']],
      ['signal_excursions', ['computed_at']],
    ];
    expect(required.filter(([t, c]) => !indexed(t, c)).map(([t, c]) => `${t}(${c.join(',')})`)).toEqual([]);
  });
});
