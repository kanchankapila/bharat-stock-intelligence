
import { dbGet } from './dbAsync';

export interface QuantScores {
  symbol: string;
  return_1m: number | null;
  return_3m: number | null;
  return_6m: number | null;
  return_12m: number | null;
  above_sma200: number | null;
  sma200_distance_pct: number | null;
  momentum_score: number | null;
  annualized_vol: number | null;
  sharpe_ratio: number | null;
  max_drawdown_1y: number | null;
  vol_rank: number | null;
  sharpe_rank: number | null;
  trailing_pe: number | null;
  forward_pe: number | null;
  debt_to_equity: number | null;
  return_on_equity: number | null;
  operating_margins: number | null;
  revenue_growth: number | null;
  piotroski_f_score: number | null;
  valuation_score: number | null;
  bullish_screener_count: number | null;
  bearish_screener_count: number | null;
  screener_category_breadth: number | null;
  screener_net_score: number | null;
  confluence_rank: number | null;
  rank_momentum: number | null;
  rank_quality: number | null;
  rank_value: number | null;
  rank_composite: number | null;
  composite_class: string | null;
  ohlcv_days: number | null;
  last_computed: string | null;
  return_1w: number | null;
  beta_1y: number | null;
  beta_6m: number | null;
  sortino_ratio: number | null;
  var_95: number | null;
  mf_quality_score: number | null;
  mf_momentum_score: number | null;
  mf_value_score: number | null;
  mf_risk_adj_score: number | null;
  mf_macro_score: number | null;
  mf_composite_score: number | null;

  // Aliased for compatibility with existing UI components
  overall_score: number;
  value_score: number;
  quality_score: number;
  sentiment_score: number;
}

export async function getQuantScoresBySymbol(symbol: string): Promise<QuantScores | undefined> {
  try {
    // The UI expects overall_score, value_score, quality_score, sentiment_score.
    // The DB has rank_composite, valuation_score, mf_quality_score.
    // We will alias them and return 0 for sentiment_score.
    const row = await dbGet<any>(`
      SELECT
        symbol,
        return_1m,
        return_3m,
        return_6m,
        return_12m,
        above_sma200,
        sma200_distance_pct,
        momentum_score,
        annualized_vol,
        sharpe_ratio,
        max_drawdown_1y,
        vol_rank,
        sharpe_rank,
        trailing_pe,
        forward_pe,
        debt_to_equity,
        return_on_equity,
        operating_margins,
        revenue_growth,
        piotroski_f_score,
        valuation_score,
        bullish_screener_count,
        bearish_screener_count,
        screener_category_breadth,
        screener_net_score,
        confluence_rank,
        rank_momentum,
        rank_quality,
        rank_value,
        rank_composite,
        composite_class,
        ohlcv_days,
        last_computed,
        return_1w,
        beta_1y,
        beta_6m,
        sortino_ratio,
        var_95,
        mf_quality_score,
        mf_momentum_score,
        mf_value_score,
        mf_risk_adj_score,
        mf_macro_score,
        mf_composite_score,
        rank_composite as overall_score,
        valuation_score as value_score,
        mf_quality_score as quality_score,
        0 as sentiment_score 
      FROM quant_scores
      WHERE symbol = ?
    `, [symbol]);

    return row as QuantScores;
  } catch (error) {
    console.error(`❌ Error fetching quant scores for ${symbol} from DB:`, error);
    return undefined;
  }
}
