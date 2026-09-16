/**
 * Provider Score Consistency & Market Growth Service
 * 
 * Exposes methods to query score consistency across providers (Trendlyne, NiftyTrader, 
 * Tickertape, MoneyControl, Quant Engine) and evaluate market growth performance.
 */
import { dbAll, dbGet } from './dbAsync';

export interface ProviderConsistencyRecord {
  id: number;
  run_at: string;
  metric_type: string;
  provider_a: string;
  provider_b?: string;
  factor_a: string;
  factor_b?: string;
  horizon_days?: number;
  sample_count: number;
  spearman_ic: number;
  concordance_pct?: number;
  q5_return?: number;
  q1_return?: number;
  quintile_lift?: number;
  win_rate_pct?: number;
  details?: any;
}

/**
 * Scales are NOT uniform across providers, and the field names here say which is which.
 * `*_pct` is genuinely 0-100 and safe to compare/average. Tickertape is NOT: its
 * scorecard is a 3-level ordinal (tickertape_scorecard_fetcher.py's
 * ORDINAL_MAP = {low:0, avg:1, high:2}), so it is exposed as its own label string and
 * deliberately kept out of every numeric comparison below. Live-verified 2026-08-28:
 * proprietary_scores_history holds min 0.0 / max 2.0 for both tickertape score_types,
 * against 0-100 for niftytrader technical_rating.
 */
export interface StockProviderScores {
  symbol: string;
  /** Null when no provider supplied one -- never backfilled with today's date. */
  date: string | null;
  trendlyne_durability_pct?: number;
  trendlyne_valuation_pct?: number;
  trendlyne_momentum_pct?: number;
  niftytrader_technical_pct?: number;
  /** 3-level ordinal label ('Low' | 'Avg' | 'High'), not a percentage. */
  tickertape_performance_grade?: string;
  /** 3-level ordinal label ('Low' | 'Avg' | 'High'), not a percentage. */
  tickertape_valuation_grade?: string;
  quant_momentum_pct?: number;
  quant_quality_pct?: number;
  quant_composite_pct?: number;
  /** Canonical unified_recommendations.unified_score. */
  unified_score?: number;
  /** stock_scores.score -- a COMPONENT INPUT to the ranker, not a final score. Present
   *  only as cold-start context; see .claude/rules/scoring-authority.md. */
  legacy_stock_score?: number;
  max_divergence_delta?: number;
  divergence_notes?: string[];
}

/**
 * Fetch cross-provider score consistency matrix.
 */
export async function getProviderConsistencyMatrix(): Promise<ProviderConsistencyRecord[]> {
  const rows = await dbAll(`
    SELECT *
    FROM provider_score_consistency_audit
    WHERE metric_type = 'cross_provider_consistency'
    ORDER BY spearman_ic DESC
  `);
  return rows as unknown as ProviderConsistencyRecord[];
}

/**
 * Fetch market growth predictive performance per provider factor.
 */
export async function getProviderMarketGrowthPerformance(horizonDays: number = 21): Promise<ProviderConsistencyRecord[]> {
  const rows = await dbAll(`
    SELECT *
    FROM provider_score_consistency_audit
    WHERE metric_type = 'market_growth_performance' AND horizon_days = ?
    ORDER BY spearman_ic DESC
  `, [horizonDays]);
  return rows as unknown as ProviderConsistencyRecord[];
}

/**
 * Get multi-provider normalized scores & agreement/divergence for a given stock symbol.
 */
export async function getStockProviderConsistency(symbol: string): Promise<StockProviderScores | null> {
  const symbolUpper = symbol.toUpperCase();

  // 1. Trendlyne DVM
  const tlRow: any = await dbGet(`
    SELECT d_score, v_score, m_score, date
    FROM trendlyne_dvm_scores
    WHERE symbol = ?
    ORDER BY date DESC LIMIT 1
  `, [symbolUpper]);

  // 2. Proprietary Scores (NiftyTrader, Tickertape)
  const propRows: any[] = await dbAll(`
    SELECT source, score_type, score_value, score_label, date
    FROM proprietary_scores_history
    WHERE symbol = ?
    ORDER BY date DESC
  `, [symbolUpper]);

  // 3. Quant Scores
  const quantRow: any = await dbGet(`
    SELECT mf_momentum_score, mf_quality_score, mf_value_score, mf_composite_score, last_computed
    FROM quant_scores
    WHERE symbol = ?
  `, [symbolUpper]);

  // 4. Canonical unified score (scoring-authority.md: unified_recommendations is the
  //    canonical cross-source ranking; stock_scores is one of its INPUTS, not a peer).
  const unifiedRow: any = await dbGet(`
    SELECT unified_score, generated_at
    FROM unified_recommendations
    WHERE symbol = ?
    ORDER BY generated_at DESC LIMIT 1
  `, [symbolUpper]);

  // 5. Legacy component score, surfaced separately and clearly labelled.
  const stockScoreRow: any = await dbGet(`
    SELECT score, updated_at
    FROM stock_scores
    WHERE symbol = ? AND timeframe = 'daily'
  `, [symbolUpper]);

  if (!tlRow && propRows.length === 0 && !quantRow && !unifiedRow && !stockScoreRow) {
    return null;
  }

  const numOf = (v: any): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // Rows arrive newest-first; first row per (source, score_type) wins. The guard is a
  // separate `seen` set, NOT `key in propMap` -- a newest row whose score_value is NULL
  // would otherwise leave propMap unset and let an OLDER row's label through.
  const propMap: Record<string, number> = {};
  const propLabels: Record<string, string> = {};
  const seen = new Set<string>();
  propRows.forEach((r: any) => {
    const key = `${r.source}_${r.score_type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const v = numOf(r.score_value);
    if (v !== undefined) propMap[key] = v;
    if (r.score_label) propLabels[key] = String(r.score_label);
  });

  const tlMom = tlRow ? numOf(tlRow.m_score) : undefined;
  const ntTech = propMap['niftytrader_technical_rating'];
  const quantMom = quantRow ? numOf(quantRow.mf_momentum_score) : undefined;
  const quantComp = quantRow ? numOf(quantRow.mf_composite_score) : undefined;

  let maxDivergence = 0;
  const notes: string[] = [];

  if (tlMom !== undefined && ntTech !== undefined) {
    const diff = Math.abs(tlMom - ntTech);
    if (diff > maxDivergence) maxDivergence = diff;
    if (diff >= 30) {
      notes.push(`Significant divergence between Trendlyne Momentum (${tlMom.toFixed(0)}) and NiftyTrader Technical (${ntTech.toFixed(0)})`);
    }
  }

  if (tlMom !== undefined && quantMom !== undefined) {
    const diff = Math.abs(tlMom - quantMom);
    if (diff > maxDivergence) maxDivergence = diff;
  }

  // No `new Date()` fallback: fabricating today's date for a record no provider dated
  // makes stale/absent data render as current. Null means "no provider supplied a date".
  const asOf: string | null =
    tlRow?.date ?? unifiedRow?.generated_at ?? stockScoreRow?.updated_at ?? null;

  return {
    symbol: symbolUpper,
    date: asOf === null ? null : String(asOf),
    trendlyne_durability_pct: tlRow ? numOf(tlRow.d_score) : undefined,
    trendlyne_valuation_pct: tlRow ? numOf(tlRow.v_score) : undefined,
    trendlyne_momentum_pct: tlMom,
    niftytrader_technical_pct: ntTech,
    tickertape_performance_grade: propLabels['tickertape_performance'],
    tickertape_valuation_grade: propLabels['tickertape_valuation'],
    quant_momentum_pct: quantMom,
    quant_quality_pct: quantRow ? numOf(quantRow.mf_quality_score) : undefined,
    quant_composite_pct: quantComp,
    unified_score: unifiedRow ? numOf(unifiedRow.unified_score) : undefined,
    legacy_stock_score: stockScoreRow ? numOf(stockScoreRow.score) : undefined,
    max_divergence_delta: Number(maxDivergence.toFixed(1)),
    divergence_notes: notes
  };
}

