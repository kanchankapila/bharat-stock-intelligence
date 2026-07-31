-- Up Migration
--
-- Fifth full-stack-audit pass (2026-07-30) confirmed both tables have ZERO writers and ZERO
-- readers anywhere in the live application (src/server/*.py, src/server/*.ts, all routers) --
-- grep-verified across the whole codebase. Both also have no PRIMARY KEY/UNIQUE constraint.
--
-- chart_patterns: a raw, unmapped JSON-flattened dump of MoneyControl's chart-patterns API
-- (userid, meta_data_* prefixed columns) -- clearly a first-draft precursor to the properly
-- schemad mc_chart_patterns table (UNIQUE(mcsymbol, pattern_id), clean columns, indices,
-- written by the live mc_chart_patterns_fetcher.py), which superseded it. The only remaining
-- references to "chart_patterns" in the repo are 2 standalone one-off analysis scripts
-- (scripts/fetch_chart_patterns.py, scripts/generate_accuracy_report.py) that connect to
-- their OWN hardcoded local database.sqlite file directly via sqlite3.connect() -- not
-- db_compat.py, not the production Postgres DB, not invoked from queues.ts or any router.
-- Dropping this table has no effect on those scripts (fetch_chart_patterns.py recreates its
-- own local table via DROP TABLE IF EXISTS/CREATE TABLE IF NOT EXISTS on every run regardless).
--
-- institutional_rankings: a superseded draft of the composite quant scoring pipeline (pe, ps,
-- earnings_yield, rev_growth, eps_growth, roe, op_margin, f_score, value_score, growth_score,
-- quality_score, composite_score) -- structurally near-identical to the live, actively-written
-- quant_scores table, which replaced it. No live or standalone script references it at all.
DROP TABLE IF EXISTS "chart_patterns";
DROP TABLE IF EXISTS "institutional_rankings";

-- Down Migration
--
-- Recreated verbatim from db/schema.postgres.sql as it existed before this migration, for
-- rollback safety. Neither table has a PK/UNIQUE (matching the original definition) -- this
-- is a straight schema restore, not a design fix; if either table is ever revived for a new
-- writer, add a proper key at that time.
CREATE TABLE IF NOT EXISTS "chart_patterns" (
  "userid" BIGINT,
  "instrument_type" TEXT,
  "instrument" TEXT,
  "exchange" TEXT,
  "pattern_name" TEXT,
  "comment" TEXT,
  "time_frame" TEXT,
  "sc_id" TEXT,
  "is_closed" TEXT,
  "is_deleted" BIGINT,
  "end_date" TEXT,
  "p_status" TEXT,
  "pattern_id" BIGINT,
  "analyst_name" TEXT,
  "analyst_image" TEXT,
  "updated_at" TEXT,
  "created_at" TEXT,
  "updated_at_epoch" BIGINT,
  "created_at_epoch" BIGINT,
  "sc_name" TEXT,
  "symbol" TEXT,
  "chartType" TEXT,
  "displayLock" TEXT,
  "scanproflg" BIGINT,
  "meta_data_chart_type" TEXT,
  "meta_data_sc_name" TEXT,
  "meta_data_sc_symbol" TEXT,
  "meta_data_sc_scripcode" TEXT,
  "meta_data_instrument_type_code" TEXT,
  "meta_data_entry_condition" TEXT,
  "meta_data_entry_price" TEXT,
  "meta_data_pattern_type" TEXT,
  "meta_data_cmp" TEXT,
  "meta_data_price_key" TEXT,
  "meta_data_target_price" TEXT,
  "meta_data_target_return_prcnt" TEXT,
  "meta_data_stoploss_price" TEXT,
  "meta_data_stoploss_prcnt" TEXT,
  "meta_data_ind_id" TEXT,
  "meta_data_expiry_date" TEXT,
  "meta_data_timeline" TEXT
);

CREATE TABLE IF NOT EXISTS "institutional_rankings" (
  "symbol" TEXT,
  "pe" DOUBLE PRECISION,
  "ps" DOUBLE PRECISION,
  "earnings_yield" DOUBLE PRECISION,
  "rev_growth" DOUBLE PRECISION,
  "eps_growth" DOUBLE PRECISION,
  "roe" DOUBLE PRECISION,
  "op_margin" DOUBLE PRECISION,
  "price" DOUBLE PRECISION,
  "ma200" DOUBLE PRECISION,
  "debt_to_equity" DOUBLE PRECISION,
  "interest_coverage" DOUBLE PRECISION,
  "avg_vol_usd" DOUBLE PRECISION,
  "f_score" BIGINT,
  "pass_safety" INTEGER,
  "score_pe" DOUBLE PRECISION,
  "score_ps" DOUBLE PRECISION,
  "score_ey" DOUBLE PRECISION,
  "score_rev" DOUBLE PRECISION,
  "score_eps" DOUBLE PRECISION,
  "score_roe" DOUBLE PRECISION,
  "score_margin" DOUBLE PRECISION,
  "dist_ma200" DOUBLE PRECISION,
  "score_momentum" DOUBLE PRECISION,
  "value_score" DOUBLE PRECISION,
  "growth_score" DOUBLE PRECISION,
  "quality_score" DOUBLE PRECISION,
  "composite_score" DOUBLE PRECISION
);
