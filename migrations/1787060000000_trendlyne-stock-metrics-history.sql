-- Up Migration
--
-- trendlyneDailyFetchService.ts's runTrendlyneMetricsFetch() calls fetchTrendlyneStockMetrics()
-- daily for the top-500-by-market-cap symbols purely to warm a Redis cache for a stock-detail
-- popup ("No DB persistence happens here -- this is pure cache-warming", per that file's own
-- comment). Every fetched value was discarded after the 12h cache TTL, including PEG_TTM,
-- PBV_A, and INSTIHOLD -- confirmed live 2026-08-15, none exist anywhere else in this schema.
--
-- This table persists what the daily job already fetches, at no extra network cost. 16 columns,
-- one per Trendlyne "Stock Metrics" parameter, wide rather than EAV: the parameter set is fixed
-- and small (confirmed live against a real response), and a wide table lets a freshness check
-- and any future measurement pass use plain SQL instead of a pivot.
--
-- Several of the 16 overlap with columns that already exist elsewhere -- MCAP_Q (nse_stocks.
-- market_cap), PE_TTM, PITROSKI_F/ROE_A/OPMPCT_* (feature_store.piotroski_f/roe/op_margins,
-- already measured, see measurement.md's feature_store sweep), NP_*_GROWTH (mc_earnings_rapid,
-- technical_signals, trendlyne_stock_profile). Kept anyway rather than curated at persist time:
-- this table's job is to stop discarding data already in hand, not to pre-judge which of the 16
-- turns out useful -- that is a measurement-time decision (see the "NOT wired to ML" note in
-- trendlyneDailyFetchService.ts), not a schema-time one. Genuinely novel per the same live
-- check: PEG_TTM, PBV_A, INSTIHOLD, relp_nifty50_qtr_change_pct, relp_sector_qtr_change_pct.
--
-- Not a hypertable: same cadence/scale class as marketsmojo_*_history (~500 symbols/day), which
-- are plain tables, not the high-frequency price/tick tables that need compression.

CREATE TABLE IF NOT EXISTS trendlyne_stock_metrics_history (
  symbol                      TEXT NOT NULL,
  date                        TEXT NOT NULL,
  mcap_q                      DOUBLE PRECISION,
  pe_ttm                      DOUBLE PRECISION,
  peg_ttm                     DOUBLE PRECISION,
  pbv_a                       DOUBLE PRECISION,
  instihold_pct               DOUBLE PRECISION,
  rev_growth_qtr_yoy_pct      DOUBLE PRECISION,
  rev_growth_ttm_pct          DOUBLE PRECISION,
  np_growth_qtr_yoy_pct       DOUBLE PRECISION,
  np_growth_ttm_pct           DOUBLE PRECISION,
  op_margin_qtr_pct           DOUBLE PRECISION,
  op_margin_ttm_pct           DOUBLE PRECISION,
  piotroski_f                 DOUBLE PRECISION,
  relp_nifty50_qtr_change_pct DOUBLE PRECISION,
  relp_sector_qtr_change_pct  DOUBLE PRECISION,
  roe_a                       DOUBLE PRECISION,
  roa_a                       DOUBLE PRECISION,
  fetched_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_tl_stock_metrics_date ON trendlyne_stock_metrics_history (date);

-- Down Migration
DROP TABLE IF EXISTS trendlyne_stock_metrics_history;
