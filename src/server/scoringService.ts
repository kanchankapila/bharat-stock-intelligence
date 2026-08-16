import { exec } from 'child_process';
import path from 'path';
import { dbGet, dbAll, dbRun } from './dbAsync';
import { syncAllScreenerStocksToDB } from './trendlyneScreener';
import { syncMoneyControlScreeners } from './moneycontrolScreener';
import { initEtnowScreeners } from './etnow';
import { alphaQuant } from './alphaQuantClient';

export interface ScoredStock {
  symbol: string;
  timeframe: string;
  stock_id: string;
  score: number;
  confidence: number;
  classification: string;
  positive_count: number;
  negative_count: number;
  reasons: Array<{ name: string; sentiment: string; source: string }>;
  last_updated: string;
  top_domain?: string;
  position_size_pct?: number;   // #6 suggested portfolio weight (0 for non-buys)
}

export interface FactorBreakdown {
  symbol: string;
  timeframe: string;
  technical: number;
  fundamental: number;
  momentum: number;
  valuation: number;
  delivery: number;
  last_updated: string;
}

/**
 * Recalculate all stock scores by running the Python engine
 */
export async function recalculateScores(): Promise<{ success: boolean; message: string }> {
  try {
    console.log('[SCORING] Running AlphaQuant Scoring Engine via FastAPI');
    const data = await alphaQuant.score({ rebuild: false });
    console.log('[SCORING] Done:', data.message);
    return { success: true, message: data.message };
  } catch (error: any) {
    console.error('[SCORING] Engine error:', error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Perform a full sync and then recalculate scores
 */
export async function syncAndScore(): Promise<{ success: boolean; message: string }> {
  console.log('🔄 Initiating full sync and score process...');

  // Ensure ETnow screeners exist in DB (idempotent — safe to call every time)
  await initEtnowScreeners();

  const syncResult = await syncAllScreenerStocksToDB('long_term');
  if (!syncResult.success) {
    console.error(`Trendlyne sync failed: ${syncResult.error}`);
  }
  
  try {
    await syncMoneyControlScreeners('long_term');
  } catch (err: any) {
    console.error(`MoneyControl sync failed: ${err.message}`);
  }

  try {
    const { syncETnowScreeners } = await import('./etnowScreenerSync');
    await syncETnowScreeners('long_term');
  } catch (err: any) {
    console.error(`ETNow sync failed: ${err.message}`);
  }
  
  const scoreResult = await recalculateScores();
  return scoreResult;
}

/** Map a unified_recommendations row to the ScoredStock shape the Top Rated UI renders. */
function mapRecToScoredStock(rec: any): ScoredStock {
  const sentiment = String(rec.classification || '').includes('Sell') ? 'bearish'
                  : String(rec.classification || '').includes('Buy')  ? 'bullish' : 'neutral';
  let reasons: Array<{ name: string; sentiment: string; source: string }> = [];
  try {
    reasons = (JSON.parse(rec.screener_names_json || '[]') as string[])
      .map(name => ({ name, sentiment, source: 'unified' }));
  } catch { /* leave empty */ }
  if (reasons.length === 0 && rec.trade_reasoning) {
    reasons = [{ name: rec.trade_reasoning, sentiment, source: 'unified' }];
  }
  const domains: Array<[string, number]> = [
    ['Screener',   rec.screener_stock_score ?? 0],
    ['ML',         rec.ml_score ?? 0],
    ['Confluence', rec.confluence_score ?? 0],
    ['Technical',  rec.technical_score ?? 0],
    ['DL',         rec.dl_score ?? 0],
  ];
  const top_domain = domains.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return {
    symbol:         rec.symbol,
    timeframe:      'long_term',
    stock_id:       rec.symbol,
    score:          rec.unified_score,
    confidence:     rec.unified_score ?? 0,   // 0-100; the UI renders confidence.toFixed(0) + '%'
    classification: rec.classification ?? 'Hold',
    positive_count: rec.bullish_screener_count ?? 0,
    negative_count: rec.bearish_screener_count ?? 0,
    reasons,
    last_updated:   rec.computed_at,
    top_domain,
    position_size_pct: rec.position_size_pct ?? 0,
  };
}

const _topRatedCache = new Map<string, { data: ScoredStock[]; expires: number }>();
const TOP_RATED_TTL_MS = 2 * 60 * 1000; // 2-minute in-process cache

export function clearTopRatedCache(): void {
  _topRatedCache.clear();
}

/**
 * Get top rated stocks. Long-term reads the canonical cross-source ranking
 * (unified_recommendations); intraday stays on stock_scores (the ranker has negligible
 * intraday coverage). Falls back to stock_scores if the ranker has produced no rows yet.
 */
export async function getTopRatedStocks(limit: number = 50, timeframe: string = 'long_term'): Promise<ScoredStock[]> {
  const cacheKey = `${timeframe}:${limit}`;
  const cached = _topRatedCache.get(cacheKey);
  if (cached) {
    if (cached.expires > Date.now()) return cached.data;
    _topRatedCache.delete(cacheKey);
  }

  try {
    let result: ScoredStock[];

    if (timeframe === 'long_term') {
      const recs = await dbAll<any>(`
        SELECT * FROM unified_recommendations
        WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
        ORDER BY unified_score DESC
        LIMIT ?
      `, [limit]);
      if (recs.length > 0) {
        result = recs.map(mapRecToScoredStock);
        _topRatedCache.set(cacheKey, { data: result, expires: Date.now() + TOP_RATED_TTL_MS });
        return result;
      }
    }

    const rows = await dbAll<any>(`
      SELECT * FROM stock_scores
      WHERE timeframe = ?
      ORDER BY score DESC
      LIMIT ?
    `, [timeframe, limit]);

    result = rows.map(row => ({
      ...row,
      reasons: (() => { try { return JSON.parse(row.reasons || '[]'); } catch { return []; } })(),
    }));
    _topRatedCache.set(cacheKey, { data: result, expires: Date.now() + TOP_RATED_TTL_MS });
    return result;
  } catch (error) {
    console.error('❌ Error fetching top rated stocks:', error);
    return [];
  }
}

/**
 * Get detailed score and factor breakdown for a specific stock
 */
export async function getStockScoreDetail(symbol: string, timeframe: string = 'long_term'): Promise<{ score: ScoredStock; factors: FactorBreakdown } | null> {
  try {
    const scoreRow = await dbGet<any>('SELECT * FROM stock_scores WHERE symbol = ? AND timeframe = ?', [symbol, timeframe]);
    if (!scoreRow) return null;

    const factorRow = await dbGet<any>('SELECT * FROM stock_factor_breakdown WHERE symbol = ? AND timeframe = ?', [symbol, timeframe]);
    
    return {
      score: {
        ...scoreRow,
        reasons: JSON.parse(scoreRow.reasons || '[]')
      },
      factors: factorRow || {
        symbol,
        timeframe,
        technical: 0,
        fundamental: 0,
        momentum: 0,
        valuation: 0,
        delivery: 0,
        last_updated: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error(`❌ Error fetching score details for ${symbol} (${timeframe}):`, error);
    return null;
  }
}

export async function computeTimeframeScores(opts: {
  runId?: string;
  screenerId?: string;
  timeframe?: 'intraday' | 'short' | 'medium' | 'long';
  topN?: number;
}): Promise<Array<{ symbol: string; score: number; confidence?: number; domains?: Record<string, number> }>> {
  const timeframe = opts.timeframe ?? 'short';
  const topN = opts.topN ?? 100;
  const holdingDays = timeframe === 'intraday' ? 1 : timeframe === 'short' ? 7 : timeframe === 'medium' ? 30 : 180;

  // `computed_at`, not `updated_at`. db.ts's SQLite schema-of-record declares the column as
  // `updated_at`; live Postgres has never had it -- the real column is `computed_at`. So every
  // write this function has ever attempted against production raised
  // `column "updated_at" of relation "timeframe_scores" does not exist`, which is why the live
  // table holds 0 rows. Found 2026-08-16 by the Phase 2 move of the vitest suite onto real
  // Postgres; the SQLite-backed test passed against the broken SQL for its whole life, which is
  // precisely the bug class the SQLite decommission exists to end (recurring-bugs.md: "a column
  // type assumed from db.ts" / "a column referenced in SQL is not a column that exists").
  const upsertSql = `
    INSERT INTO timeframe_scores (symbol, timeframe, run_id, score, confidence, domains_json, reasons_json, suggested_holding_days, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe, run_id) DO UPDATE SET
      run_id = excluded.run_id, score = excluded.score, confidence = excluded.confidence,
      domains_json = excluded.domains_json, reasons_json = excluded.reasons_json,
      suggested_holding_days = excluded.suggested_holding_days, computed_at = excluded.computed_at
  `;

  // ── Path A: runId provided → load stocks from screener_runs, compute from component tables ──
  if (opts.runId) {
    const run = await dbGet<any>('SELECT records_json FROM screener_runs WHERE run_id = ?', [opts.runId]);
    let symbols: string[] = [];
    if (run?.records_json) {
      try { symbols = (JSON.parse(run.records_json) as any[]).map((r: any) => r.symbol).filter(Boolean).slice(0, topN); } catch (e) { console.warn(e); }
    }
    if (!symbols.length) return [];

    const now = new Date().toISOString();
    const results: Array<{ symbol: string; score: number; confidence: number; domains: Record<string, number> }> = [];

    for (const sym of symbols) {
      const qs  = await dbGet<any>('SELECT momentum_score, return_1m FROM quant_scores WHERE symbol = ?', [sym]);
      const tcs = await dbGet<any>('SELECT composite_score FROM technical_composite_scores WHERE symbol = ?', [sym]);
      const sf  = await dbGet<any>('SELECT return_on_equity FROM stock_fundamentals WHERE symbol = ?', [sym]);

      const momentum   = Math.min(100, Math.max(0, qs?.momentum_score  ?? 0));
      const technical  = Math.min(100, Math.max(0, tcs?.composite_score ?? 0));
      const fundamental = sf ? Math.min(100, Math.max(0, (sf.return_on_equity ?? 0) * 200)) : 0;

      const sourcesAvailable = [qs, tcs, sf].filter(Boolean).length;
      const score      = sourcesAvailable > 0 ? (momentum * 0.4 + technical * 0.4 + fundamental * 0.2) : 0;
      const confidence = sourcesAvailable / 3;
      const domains    = { momentum, technical, fundamental };

      await dbRun(upsertSql, [sym, timeframe, opts.runId, score, confidence, JSON.stringify(domains), '[]', holdingDays, now]);
      results.push({ symbol: sym, score, confidence, domains });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // ── Path B: screenerId or no filter → read pre-computed scores from stock_scores ──
  const dbTimeframe = timeframe === 'intraday' ? 'intraday' : 'long_term';
  const params: unknown[] = [dbTimeframe];
  let sql = `SELECT ss.symbol, ss.score, ss.confidence, ss.reasons AS reasons_json FROM stock_scores ss WHERE ss.timeframe = ?`;

  if (opts.screenerId) {
    sql += ` AND ss.symbol IN (SELECT DISTINCT symbol FROM screener_appearances WHERE screener_id = ?)`;
    params.push(opts.screenerId);
  }
  sql += ` ORDER BY ss.score DESC LIMIT ?`;
  params.push(topN);

  const rows = await dbAll<any>(sql, params);

  // Auto-create a screener_runs entry when a screenerId is provided.
  //
  // run_id is part of the live PRIMARY KEY (symbol, timeframe, run_id), so it can never be NULL
  // -- this used to default to null whenever no screenerId was passed, which would fail the
  // upsert outright. db.ts declared a 2-column key and hid that; see the upsert's own comment.
  let resolvedRunId = `run_adhoc_${timeframe}_${Date.now()}`;
  if (opts.screenerId && rows.length > 0) {
    resolvedRunId = `run_${opts.screenerId}_${Date.now()}`;
    try {
      await dbRun(`
        INSERT INTO screener_runs (run_id, screener_id, run_ts, records_json, symbol_count, triggered_by)
        VALUES (?, ?, datetime('now'), ?, ?, 'auto')
        ON CONFLICT(run_id) DO NOTHING
      `, [resolvedRunId, opts.screenerId, JSON.stringify(rows.map((r: any) => ({ symbol: r.symbol }))), rows.length]);
    } catch { /* non-fatal */ }
  }

  const now = new Date().toISOString();
  for (const row of rows) {
    await dbRun(upsertSql, [row.symbol, timeframe, resolvedRunId, row.score ?? 0, row.confidence ?? 0, '{}', row.reasons_json ?? '[]', holdingDays, now]);
  }

  return rows.map((r: any) => ({ symbol: r.symbol, score: r.score ?? 0 }));
}
