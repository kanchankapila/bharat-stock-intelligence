import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
const dbModule = await import('../db');
const db = dbModule.default;
const scoringServiceModule = await import('../scoringService');
const { computeTimeframeScores } = scoringServiceModule;

beforeEach(() => {
  ['screener_runs', 'timeframe_scores', 'quant_scores', 'technical_composite_scores', 'stock_fundamentals', 'stock_ohlcv', 'backtesting_runs']
    .forEach(table => db.exec(`DELETE FROM ${table}`));
});

describe('scoringService', () => {
  it('computes timeframe scores for a screener run and persists results', async () => {
    db.prepare('INSERT INTO screener_runs (run_id, screener_id, records_json) VALUES (?, ?, ?)')
      .run('run1', 'S123', JSON.stringify([{ symbol: 'TEST' }]));

    db.prepare('INSERT INTO quant_scores (symbol, return_1w, return_1m, momentum_score, rank_momentum) VALUES (?, ?, ?, ?, ?)')
      .run('TEST', 2.4, 5.1, 65, 80);
    db.prepare('INSERT INTO technical_composite_scores (symbol, composite_score) VALUES (?, ?)')
      .run('TEST', 72);
    db.prepare('INSERT INTO stock_fundamentals (symbol, trailing_pe, return_on_equity, avg_volume_3m, market_cap) VALUES (?, ?, ?, ?, ?)')
      .run('TEST', 18.5, 0.21, 600000, 18000000000);

    const results = await computeTimeframeScores({ runId: 'run1', timeframe: 'short', topN: 10 }) as any[];

    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe('TEST');
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].confidence).toBeGreaterThan(0);
    expect(results[0].domains.momentum).toBeGreaterThanOrEqual(0);

    const row = db.prepare('SELECT * FROM timeframe_scores WHERE run_id = ? AND symbol = ?').get('run1', 'TEST') as any;
    expect(row).toBeTruthy();
    expect(row.timeframe).toBe('short');
    expect(typeof row.domains_json).toBe('string');
  });
});
