-- Up Migration
--
-- quant_scores is PRIMARY KEY (symbol) with NO date column of any kind -- one row per symbol,
-- overwritten in place by every run. It is one of the three score producers feeding
-- unified_recommendations (see scoring-authority.md) and unified_ranker.py reads it with no date
-- filter at all (unified_ranker.py:1158, :1773).
--
-- Consequence, established 2026-08-12 while asking whether the canonical ranker's history could
-- be backfilled: it cannot. What a symbol's piotroski_f_score / return_on_equity /
-- annualized_vol / mf_composite_score was on any past date is permanently gone, so a
-- reconstructed "what the ranker would have said in July" would have to substitute TODAY's
-- quant_scores -- a direct look-ahead leak, and a severe one, since today's annualized_vol
-- embeds the very price action the reconstruction would then be graded against, and
-- annualized_vol drives the high_vol veto rather than a rounding term.
--
-- This table does not recover the past. It stops the same answer being "no" again: from now on
-- there are two gradeable layers accumulating (this and unified_recommendations_history,
-- migration 1786940000000) instead of one.
--
-- Append-only, PK (symbol, snapshot_date), ON CONFLICT DO NOTHING at the writer. Mirrors all 44
-- columns of quant_scores rather than a chosen subset: selecting a subset is how you discover in
-- six weeks that the one column you needed was the one nobody listed, which is the exact failure
-- mode this table exists to prevent. ~2,424 rows/day is negligible.
--
-- The companion quant-scores-history-column-parity data-quality check fails if quant_scores ever
-- gains a column this table lacks, so the mirror cannot silently go stale -- the same
-- derive-from-information_schema guard used for signal-source-table-coverage, and for the same
-- reason: a hand-enumerated list only covers what someone remembered.

CREATE TABLE IF NOT EXISTS quant_scores_history (
  symbol                       TEXT NOT NULL,
  -- The session these scores DESCRIBE, anchored to MAX(date) FROM stock_ohlcv by the writer --
  -- not a wall clock. quant_scores is derived from OHLCV, so that is definitionally the session
  -- it reflects, and it stays correct if the 17:30 UTC job runs late or as a boot catch-up.
  -- Using now() here would be the date.today()-as-write-anchor class in recurring-bugs.md.
  snapshot_date                TEXT NOT NULL,
  return_1m                    DOUBLE PRECISION,
  return_3m                    DOUBLE PRECISION,
  return_6m                    DOUBLE PRECISION,
  return_12m                   DOUBLE PRECISION,
  above_sma200                 BIGINT,
  sma200_distance_pct          DOUBLE PRECISION,
  momentum_score               DOUBLE PRECISION,
  annualized_vol               DOUBLE PRECISION,
  sharpe_ratio                 DOUBLE PRECISION,
  max_drawdown_1y              DOUBLE PRECISION,
  vol_rank                     DOUBLE PRECISION,
  sharpe_rank                  DOUBLE PRECISION,
  trailing_pe                  DOUBLE PRECISION,
  forward_pe                   DOUBLE PRECISION,
  debt_to_equity               DOUBLE PRECISION,
  return_on_equity             DOUBLE PRECISION,
  operating_margins            DOUBLE PRECISION,
  revenue_growth               DOUBLE PRECISION,
  piotroski_f_score            BIGINT,
  valuation_score              DOUBLE PRECISION,
  bullish_screener_count       BIGINT,
  bearish_screener_count       BIGINT,
  screener_category_breadth    BIGINT,
  screener_net_score           DOUBLE PRECISION,
  confluence_rank              DOUBLE PRECISION,
  rank_momentum                DOUBLE PRECISION,
  rank_quality                 DOUBLE PRECISION,
  rank_value                   DOUBLE PRECISION,
  rank_composite               DOUBLE PRECISION,
  composite_class              TEXT,
  ohlcv_days                   BIGINT,
  last_computed                TIMESTAMPTZ,
  return_1w                    DOUBLE PRECISION,
  beta_1y                      DOUBLE PRECISION,
  beta_6m                      DOUBLE PRECISION,
  sortino_ratio                DOUBLE PRECISION,
  var_95                       DOUBLE PRECISION,
  mf_quality_score             DOUBLE PRECISION,
  mf_momentum_score            DOUBLE PRECISION,
  mf_value_score               DOUBLE PRECISION,
  mf_risk_adj_score            DOUBLE PRECISION,
  mf_macro_score               DOUBLE PRECISION,
  mf_composite_score           DOUBLE PRECISION,
  PRIMARY KEY (symbol, snapshot_date)
);

-- Grading sweeps a date range and joins per symbol.
CREATE INDEX IF NOT EXISTS idx_qsh_snapshot_symbol
  ON quant_scores_history (snapshot_date, symbol);

-- Seed the current state as the first snapshot, so the series starts today rather than at the
-- next 17:30 UTC run. This is the ONLY row-set whose provenance is honest: it is today's live
-- quant_scores, labelled with the session it describes. Nothing earlier can be reconstructed.
INSERT INTO quant_scores_history (
  symbol, snapshot_date, return_1m, return_3m, return_6m, return_12m, above_sma200,
  sma200_distance_pct, momentum_score, annualized_vol, sharpe_ratio, max_drawdown_1y, vol_rank,
  sharpe_rank, trailing_pe, forward_pe, debt_to_equity, return_on_equity, operating_margins,
  revenue_growth, piotroski_f_score, valuation_score, bullish_screener_count,
  bearish_screener_count, screener_category_breadth, screener_net_score, confluence_rank,
  rank_momentum, rank_quality, rank_value, rank_composite, composite_class, ohlcv_days,
  last_computed, return_1w, beta_1y, beta_6m, sortino_ratio, var_95, mf_quality_score,
  mf_momentum_score, mf_value_score, mf_risk_adj_score, mf_macro_score, mf_composite_score)
SELECT
  symbol, (SELECT MAX(date)::text FROM stock_ohlcv), return_1m, return_3m, return_6m, return_12m,
  above_sma200, sma200_distance_pct, momentum_score, annualized_vol, sharpe_ratio,
  max_drawdown_1y, vol_rank, sharpe_rank, trailing_pe, forward_pe, debt_to_equity,
  return_on_equity, operating_margins, revenue_growth, piotroski_f_score, valuation_score,
  bullish_screener_count, bearish_screener_count, screener_category_breadth, screener_net_score,
  confluence_rank, rank_momentum, rank_quality, rank_value, rank_composite, composite_class,
  ohlcv_days, last_computed, return_1w, beta_1y, beta_6m, sortino_ratio, var_95,
  mf_quality_score, mf_momentum_score, mf_value_score, mf_risk_adj_score, mf_macro_score,
  mf_composite_score
FROM quant_scores
ON CONFLICT (symbol, snapshot_date) DO NOTHING;

-- Down Migration
DROP TABLE IF EXISTS quant_scores_history;
