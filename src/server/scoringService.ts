import { exec } from 'child_process';
import path from 'path';
import { dbGet, dbAll, dbRun } from './dbAsync';
import { liquidityTier, type LiquidityTier } from './liquidityTier';
import { syncAllScreenerStocksToDB } from './trendlyneScreener';
import { syncMoneyControlScreeners } from './moneycontrolScreener';
import { initEtnowScreeners } from './etnow';
import { alphaQuant } from './alphaQuantClient';

export interface ScoredStock {
  symbol: string;
  timeframe: string;
  stock_id: string;
  score: number;
  confidence?: number;
  classification: string;
  positive_count: number;
  negative_count: number;
  reasons: Array<{ name: string; sentiment: string; source: string }>;
  last_updated: string;
  top_domain?: string;
  position_size_pct?: number | null;
  research_position_size_pct?: number | null;
  position_sizing_status?: 'UNVALIDATED';
  adt_cr?: number | null;       // ~30-session avg daily turnover, Rs crore
  liquidity?: LiquidityTier | null; // label only; never changes score/classification (AF-20261015-10)
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
  // Stored raw scores are not the normalized, gated and weighted contributions to this row.
  // A paused engine can have the largest raw value, so no driver can be inferred from them.
  return {
    symbol:         rec.symbol,
    timeframe:      rec.timeframe ?? 'UNSPECIFIED',
    stock_id:       rec.symbol,
    score:          rec.unified_score,
    classification: rec.classification ?? 'Hold',
    positive_count: rec.bullish_screener_count ?? 0,
    negative_count: rec.bearish_screener_count ?? 0,
    reasons,
    last_updated:   rec.generated_at ?? rec.computed_at,
    position_size_pct: null,
    research_position_size_pct: Number.isFinite(rec.position_size_pct) ? rec.position_size_pct : null,
    position_sizing_status: 'UNVALIDATED',
    adt_cr:         rec.adt_cr != null ? Number(rec.adt_cr) : null,
    liquidity:      liquidityTier(rec.adt_cr != null ? Number(rec.adt_cr) : null),
  };
}

const _topRatedCache = new Map<string, { data: ScoredStock[]; expires: number }>();
const TOP_RATED_TTL_MS = 2 * 60 * 1000; // 2-minute in-process cache

export function clearTopRatedCache(): void {
  _topRatedCache.clear();
}

/**
 * Get top rated stocks. Long-term reads POSITIONAL rows from the latest canonical
 * unified batch; intraday reads intraday_recommendations. Neither substitutes legacy
 * scores when canonical results are empty. Other horizons retain their legacy path.
 */
export async function getTopRatedStocks(limit: number = 50, timeframe: string = 'long_term'): Promise<ScoredStock[]> {
  const cacheKey = `${timeframe}:${limit}`;
  // Canonical intraday read: the intraday list reads intraday_recommendations (produced by
  // intraday_ranker.py, the intraday authority) -- NOT the legacy stock_scores table.
  // No legacy fallback: an empty or stale canonical batch renders as empty rather than
  // silently presenting legacy scores that no intraday engine produced.
  if (timeframe === 'intraday') {
    return getTopRatedIntraday(limit);
  }
  const cached = _topRatedCache.get(cacheKey);
  if (cached) {
    if (cached.expires > Date.now()) return cached.data;
    _topRatedCache.delete(cacheKey);
  }

  try {
    let result: ScoredStock[];

    if (timeframe === 'long_term') {
      const recs = await dbAll<any>(`
        SELECT r.*, a.adt_cr
          FROM unified_recommendations r
          LEFT JOIN (
            SELECT symbol, AVG(close * volume) / 1e7 AS adt_cr
              FROM stock_ohlcv
             WHERE date >= CURRENT_DATE - 45 AND COALESCE(is_suspect, 0) = 0
             GROUP BY symbol
          ) a ON a.symbol = r.symbol
         WHERE r.computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
           AND r.timeframe = 'POSITIONAL'
         ORDER BY r.unified_score DESC
         LIMIT ?
      `, [limit]);
      // Do not resurrect an older horizon batch or substitute a component score.
      result = recs.map(mapRecToScoredStock);
      _topRatedCache.set(cacheKey, { data: result, expires: Date.now() + TOP_RATED_TTL_MS });
      return result;
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
    throw error;
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

/**
 * Canonical intraday ranking for the TopRated intraday column.
 * Reads ONLY the latest intraday_recommendations batch, bounded for freshness:
 * intraday_ranker.py runs every 15 minutes in market hours, so anything older than
 * ~90 minutes is not a live recommendation. An empty result is the honest cold-start /
 * stale answer -- this function must never fall back to the legacy stock_scores table.
 */
export async function getTopRatedIntraday(limit: number): Promise<ScoredStock[]> {
  const cutoff = new Date(Date.now() - 90 * 60_000).toISOString();
  const rows = await dbAll(
    `SELECT symbol, computed_ts, classification, conviction_level, intraday_score AS score
       FROM intraday_recommendations
      WHERE computed_at = (SELECT MAX(computed_at) FROM intraday_recommendations)
        AND computed_ts >= ?
      ORDER BY intraday_score DESC
      LIMIT ?`,
    [cutoff, limit],
  ) as any[];
  return rows.map((r) => ({
    symbol: r.symbol,
    timeframe: 'intraday',
    stock_id: r.symbol,
    score: Number(r.score),
    classification: r.classification ?? '',
    positive_count: 0,
    negative_count: 0,
    reasons: [],
    last_updated: r.computed_ts instanceof Date ? r.computed_ts.toISOString() : r.computed_ts,
  }));
}
