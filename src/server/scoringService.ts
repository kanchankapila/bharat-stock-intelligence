import { exec } from 'child_process';
import path from 'path';
import db from './db';
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
  initEtnowScreeners();

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

/**
 * Get top rated stocks from the database
 */
export function getTopRatedStocks(limit: number = 50, timeframe: string = 'long_term'): ScoredStock[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM stock_scores 
      WHERE timeframe = ?
      ORDER BY score DESC 
      LIMIT ?
    `);
    const rows = stmt.all(timeframe, limit) as any[];
    
    return rows.map(row => ({
      ...row,
      reasons: JSON.parse(row.reasons || '[]')
    }));
  } catch (error) {
    console.error('❌ Error fetching top rated stocks:', error);
    return [];
  }
}

/**
 * Get detailed score and factor breakdown for a specific stock
 */
export function getStockScoreDetail(symbol: string, timeframe: string = 'long_term'): { score: ScoredStock; factors: FactorBreakdown } | null {
  try {
    const scoreRow = db.prepare('SELECT * FROM stock_scores WHERE symbol = ? AND timeframe = ?').get(symbol, timeframe) as any;
    if (!scoreRow) return null;

    const factorRow = db.prepare('SELECT * FROM stock_factor_breakdown WHERE symbol = ? AND timeframe = ?').get(symbol, timeframe) as any;
    
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
}): Promise<Array<{ symbol: string; score: number }>> {
  const timeframe = opts.timeframe ?? 'short';
  const topN = opts.topN ?? 100;
  const holdingDays = timeframe === 'intraday' ? 1 : timeframe === 'short' ? 7 : timeframe === 'medium' ? 30 : 180;
  const dbTimeframe = timeframe === 'intraday' ? 'intraday' : 'long_term';

  const params: unknown[] = [dbTimeframe];
  let sql = `SELECT ss.symbol, ss.score, ss.confidence, ss.reasons AS reasons_json FROM stock_scores ss WHERE ss.timeframe = ?`;

  if (opts.screenerId) {
    sql += ` AND ss.symbol IN (SELECT DISTINCT symbol FROM screener_appearances WHERE screener_id = ?)`;
    params.push(opts.screenerId);
  }
  sql += ` ORDER BY ss.score DESC LIMIT ?`;
  params.push(topN);

  const rows = db.prepare(sql).all(...params) as any[];

  // Auto-create a screener_runs entry when a screenerId is provided without an explicit runId
  let resolvedRunId = opts.runId ?? null;
  if (opts.screenerId && !opts.runId && rows.length > 0) {
    resolvedRunId = `run_${opts.screenerId}_${Date.now()}`;
    try {
      db.prepare(`
        INSERT INTO screener_runs (run_id, screener_id, run_ts, records_json, symbol_count, triggered_by)
        VALUES (?, ?, datetime('now'), ?, ?, 'auto')
        ON CONFLICT(run_id) DO NOTHING
      `).run(
        resolvedRunId,
        opts.screenerId,
        JSON.stringify(rows.map((r: any) => ({ symbol: r.symbol }))),
        rows.length
      );
    } catch { /* non-fatal */ }
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO timeframe_scores (symbol, timeframe, run_id, score, confidence, domains_json, reasons_json, suggested_holding_days, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe) DO UPDATE SET
      run_id = excluded.run_id, score = excluded.score, confidence = excluded.confidence,
      domains_json = excluded.domains_json, reasons_json = excluded.reasons_json,
      suggested_holding_days = excluded.suggested_holding_days, updated_at = excluded.updated_at
  `);
  for (const row of rows) {
    upsert.run(row.symbol, timeframe, resolvedRunId, row.score ?? 0, row.confidence ?? 0, '{}', row.reasons_json ?? '[]', holdingDays, now);
  }

  return rows.map((r: any) => ({ symbol: r.symbol, score: r.score ?? 0 }));
}
