import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
const dbModule = await import('../db');
const db = dbModule.default;
const scoringServiceModule = await import('../scoringService');
const { computeTimeframeScores, getTopRatedStocks } = scoringServiceModule;

beforeEach(() => {
  ['screener_runs', 'timeframe_scores', 'quant_scores', 'technical_composite_scores', 'stock_fundamentals', 'stock_ohlcv', 'backtesting_runs', 'unified_recommendations', 'stock_scores']
    .forEach(table => db.exec(`DELETE FROM ${table}`));
});

const insertRec = (symbol: string, score: number, klass: string, bull: number, bear: number, computedAt: string) =>
  db.prepare(`INSERT INTO unified_recommendations
    (symbol, computed_at, regime, unified_score, conviction_level, classification,
     bullish_screener_count, bearish_screener_count, screener_names_json, trade_reasoning)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(symbol, computedAt, 'BULL', score, 'B_MEDIUM', klass, bull, bear,
         JSON.stringify(['technical_breakout', 'fundamental_quality']), `reason for ${symbol}`);

describe('getTopRatedStocks reroute to unified_recommendations', () => {
  it('returns the canonical ranking (latest day, by score desc) mapped to the ScoredStock shape', async () => {
    const today = new Date().toISOString().split('T')[0];
    const older = '2026-01-01';
    insertRec('AAA', 90, 'Strong Buy', 10, 1, today);
    insertRec('BBB', 60, 'Buy', 5, 2, today);
    insertRec('STALE', 99, 'Strong Buy', 9, 0, older); // newer-day filter must exclude this

    const rows = await getTopRatedStocks(10, 'long_term') as any[];

    expect(rows.map(r => r.symbol)).toEqual(['AAA', 'BBB']);
    expect(rows[0].score).toBe(90);
    expect(rows[0].classification).toBe('Strong Buy');
    expect(rows[0].positive_count).toBe(10);
    expect(rows[0].negative_count).toBe(1);
    expect(Array.isArray(rows[0].reasons)).toBe(true);
    expect(rows[0].reasons.length).toBeGreaterThan(0);
  });

  it('falls back to stock_scores when there are no unified_recommendations', async () => {
    db.prepare(`INSERT INTO stock_scores (symbol, timeframe, score, confidence, classification, positive_count, negative_count, reasons, last_updated)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('LEG', 'long_term', 77, 0.7, 'Buy', 3, 1, JSON.stringify([]), new Date().toISOString());

    const rows = await getTopRatedStocks(10, 'long_term') as any[];
    expect(rows.some(r => r.symbol === 'LEG')).toBe(true);
  });

  it('intraday timeframe still reads stock_scores (not rerouted)', async () => {
    const today = new Date().toISOString().split('T')[0];
    insertRec('AAA', 90, 'Strong Buy', 10, 1, today); // long_term canonical row
    db.prepare(`INSERT INTO stock_scores (symbol, timeframe, score, confidence, classification, positive_count, negative_count, reasons, last_updated)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('INTRA', 'intraday', 55, 0.6, 'Buy', 2, 0, JSON.stringify([]), new Date().toISOString());

    const rows = await getTopRatedStocks(10, 'intraday') as any[];
    expect(rows.map(r => r.symbol)).toEqual(['INTRA']);
  });
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
