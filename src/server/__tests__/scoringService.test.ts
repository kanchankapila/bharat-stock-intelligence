import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
const scoringServiceModule = await import('../scoringService');
const { getTopRatedStocks, clearTopRatedCache } = scoringServiceModule;

beforeEach(async () => {
  for (const table of ['screener_runs', 'timeframe_scores', 'quant_scores', 'technical_composite_scores', 'stock_fundamentals', 'stock_ohlcv', 'backtesting_runs', 'unified_recommendations', 'intraday_recommendations', 'stock_scores']) {

    await dbExec(`DELETE FROM ${table}`);

  }
  clearTopRatedCache();
});

const insertRec = (symbol: string, score: number, klass: string, bull: number, bear: number, computedAt: string, sizePct = 0, timeframe: string | null = 'LONG_TERM') =>
  dbRun(`INSERT INTO unified_recommendations
    (symbol, computed_at, regime, unified_score, conviction_level, classification,
     bullish_screener_count, bearish_screener_count, screener_names_json, trade_reasoning,
     screener_stock_score, ml_score, confluence_score, technical_score, dl_score, position_size_pct, timeframe)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [symbol, computedAt, 'BULL', score, 'B_MEDIUM', klass, bull, bear,
         JSON.stringify(['technical_breakout', 'fundamental_quality']), `reason for ${symbol}`,
         20, 30, 10, 95, 15, sizePct, timeframe]); // technical_score is the max -> top_domain = 'Technical'

describe('getTopRatedStocks reroute to unified_recommendations', () => {
  it('returns the canonical ranking (latest day, by score desc) mapped to the ScoredStock shape', async () => {
    const today = new Date().toISOString().split('T')[0];
    const older = '2026-01-01';
    await insertRec('AAA', 90, 'Strong Buy', 10, 1, today, 4.2);
    await insertRec('BBB', 60, 'Buy', 5, 2, today);
    await insertRec('STALE', 99, 'Strong Buy', 9, 0, older); // newer-day filter must exclude this

    const rows = await getTopRatedStocks(10, 'long_term') as any[];

    expect(rows.map(r => r.symbol)).toEqual(['AAA', 'BBB']);
    // suggested portfolio weight (#6) must surface to the UI
    expect(rows[0].position_size_pct).toBe(4.2);
    expect(rows[0].score).toBe(90);
    expect(rows[0].classification).toBe('Strong Buy');
    expect(rows[0].positive_count).toBe(10);
    expect(rows[0].negative_count).toBe(1);
    expect(Array.isArray(rows[0].reasons)).toBe(true);
    expect(rows[0].reasons.length).toBeGreaterThan(0);
    // A ranking score is not a calibrated probability or confidence percentage.
    expect(rows[0]).not.toHaveProperty('confidence');
    // "Driver: {top_domain}" must not render undefined; highest engine component wins
    expect(rows[0].top_domain).toBe('Technical');
  });

  it('filters other and unspecified horizons before applying the limit', async () => {
    const today = '2026-09-17';
    await insertRec('LONG', 60, 'Buy', 5, 0, today);
    for (const [symbol, horizon] of [['INTRA', 'INTRADAY'], ['SWING', 'SWING'], ['UNKNOWN', null]] as const) {
      await insertRec(symbol, 99, 'Strong Buy', 10, 0, today, 0, horizon);
    }
    const rows = await getTopRatedStocks(1, 'long_term');
    expect(rows.map(r => r.symbol)).toEqual(['LONG']);
    expect(rows[0].timeframe).toBe('LONG_TERM');
  });

  it('does not use an older long-term batch or legacy scores when the latest batch has no long-term rows', async () => {
    await insertRec('OLDLONG', 99, 'Strong Buy', 9, 0, '2026-09-16');
    await insertRec('SWING', 95, 'Strong Buy', 9, 0, '2026-09-17', 0, 'SWING');
    await dbRun(`INSERT INTO stock_scores (symbol, timeframe, score, reasons, last_updated)
      VALUES (?, ?, ?, ?, ?)`, ['LEG', 'long_term', 98, '[]', new Date().toISOString()]);
    expect(await getTopRatedStocks(10, 'long_term')).toEqual([]);
  });

  it('does not substitute legacy scores when canonical recommendations are absent', async () => {
    await dbRun(`INSERT INTO stock_scores (symbol, timeframe, score, confidence, classification, positive_count, negative_count, reasons, last_updated)
      VALUES (?,?,?,?,?,?,?,?,?)`, ['LEG', 'long_term', 77, 0.7, 'Buy', 3, 1, JSON.stringify([]), new Date().toISOString()]);

    const rows = await getTopRatedStocks(10, 'long_term') as any[];
    expect(rows).toEqual([]);
  });

  it('uses generation timestamps to exclude stale intraday rows on the same trading date', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T08:00:00.000Z'));
    for (const [symbol, score, timestamp] of [
      ['FRESH', 80, '2026-09-17T07:55:00.000Z'],
      ['STALE', 99, '2026-09-17T06:00:00.000Z'],
      ['UNKNOWN', 98, null],
    ] as const) {
      await dbRun(`INSERT INTO intraday_recommendations
        (symbol, computed_at, computed_ts, intraday_score, classification)
        VALUES (?, ?, ?, ?, ?)`, [symbol, '2026-09-17', timestamp, score, 'Buy']);
    }
    const rows = await getTopRatedStocks(10, 'intraday');
    expect(rows.map(r => r.symbol)).toEqual(['FRESH']);
    expect(rows[0].score).toBe(80);
    expect(rows[0].last_updated).toBe('2026-09-17T07:55:00.000Z');
    expect(rows[0].timeframe).toBe('intraday');

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T10:00:00.000Z'));
    expect(await getTopRatedStocks(10, 'intraday')).toEqual([]);
  });

  it('intraday timeframe reads canonical intraday_recommendations, never legacy stock_scores', async () => {
    const today = new Date().toISOString().split('T')[0];
    await insertRec('AAA', 90, 'Strong Buy', 10, 1, today); // long_term canonical row
    await dbRun(`INSERT INTO stock_scores (symbol, timeframe, score, confidence, classification, positive_count, negative_count, reasons, last_updated)
      VALUES (?,?,?,?,?,?,?,?,?)`, ['INTRA', 'intraday', 55, 0.6, 'Buy', 2, 0, JSON.stringify([]), new Date().toISOString()]);

    // No canonical intraday batch is inserted here: whether the environment's
    // intraday_recommendations is empty or carries live rows, the legacy stock_scores row
    // 'INTRA' must never surface through the intraday route anymore.
    const rows = await getTopRatedStocks(10, 'intraday') as any[];
    expect(rows.map(r => r.symbol)).not.toContain('INTRA');
  });
});
