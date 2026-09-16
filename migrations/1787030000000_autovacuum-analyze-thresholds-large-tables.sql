-- Up Migration
--
-- Planner statistics on this platform's largest tables were entirely absent, live-measured
-- 2026-08-15: last_analyze / last_autoanalyze / last_autovacuum were all NULL on every one of
-- the 8 tables below (300 of 419 tables platform-wide had never been analyzed). autovacuum is
-- ON and working -- small, churny tables get analyzed fine -- so this is a threshold problem,
-- not a daemon problem.
--
-- Root cause is the DEFAULT autovacuum_analyze_scale_factor of 0.1, which is a PERCENTAGE of
-- table size. On marketsmojo_technical_history (16,773,681 rows) that demands 1.68M changed
-- rows before an analyze fires. The MarketsMojo incremental-write guards added 2026-08-14
-- (recurring-bugs.md's write-amplification class) were correct and cut the nightly write volume
-- from 2,010,127 rows to ~23,000 -- which means this table now needs ~73 days of writes to
-- cross its own analyze threshold, and the other seven are worse. A correct fix removed exactly
-- the churn that was incidentally keeping statistics fresh.
--
-- Measured consequence, marketsmojo_technical_fetcher.py's own incremental guard query
-- (`SELECT symbol, indicator, period, MAX(date) ... GROUP BY 1,2,3`, run once per nightly run):
--   before ANALYZE: Parallel Seq Scan, cost 449,303, median 4.47s over 3 runs
--   after  ANALYZE: Parallel Index Only Scan using the PK, cost 378,469, median 2.60s
-- The PK (symbol, indicator, period, date) already covers that query exactly; the planner could
-- not choose an index-only scan because a never-vacuumed table has an empty visibility map.
-- ~1.7x on this one query -- modest on its own. The reason this migration exists is the other
-- side: every planner decision touching these 45M rows was being made with no statistics at all.
--
-- scale_factor = 0 with a flat threshold, deliberately, rather than a smaller percentage:
-- a percentage re-introduces the same size-dependence that caused this (the bigger the table
-- gets, the rarer its analyze), which is backwards -- large tables are exactly where a stale
-- plan costs most. A flat 50,000-row threshold is size-independent and predictable: ~2 days on
-- marketsmojo_technical_history at its current ~23k rows/night, proportionally rarer on the
-- tables that genuinely change less.
--
-- This migration changes STORAGE PARAMETERS ONLY. It inserts, updates, and deletes no rows, and
-- ALTER TABLE ... SET (...) on autovacuum parameters takes only a brief ACCESS EXCLUSIVE lock to
-- update the catalog -- it does not rewrite the table and does not scan it. None of the 8 are
-- compressed hypertables (per timescaledb_information.hypertables, only confluence_signals,
-- feature_store, intraday_ohlcv, stock_ohlcv and tick_data are), so there is no decompression
-- hazard here -- see .claude/rules/recurring-bugs.md's hypertable constraint.

ALTER TABLE marketsmojo_technical_history  SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);
ALTER TABLE marketsmojo_financials_history SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);
ALTER TABLE trendlyne_pb_history           SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);
ALTER TABLE trendlyne_pe_history           SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);
ALTER TABLE live_screener_appearances      SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);
ALTER TABLE live_screener_outcomes         SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);
ALTER TABLE nse_universe_history           SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);
ALTER TABLE mc_general_metrics             SET (autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 50000);

-- Down Migration
--
-- RESET restores the cluster defaults (currently scale_factor 0.1, threshold 50). It does not
-- discard the statistics already collected -- reverting this migration cannot lose data or
-- plans, it only returns these tables to the percentage-based cadence that left them unanalyzed.

ALTER TABLE marketsmojo_technical_history  RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
ALTER TABLE marketsmojo_financials_history RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
ALTER TABLE trendlyne_pb_history           RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
ALTER TABLE trendlyne_pe_history           RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
ALTER TABLE live_screener_appearances      RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
ALTER TABLE live_screener_outcomes         RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
ALTER TABLE nse_universe_history           RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
ALTER TABLE mc_general_metrics             RESET (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);
