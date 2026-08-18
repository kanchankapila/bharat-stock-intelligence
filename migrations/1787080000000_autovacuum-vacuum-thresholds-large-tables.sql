-- Up Migration
--
-- AF-20260818-42: marketsmojo_financials_history's dead-tuple share nearly doubled in a week
-- (7.3% -> 16.3%, live-measured 2026-08-18) despite the 2026-08-14 incremental-write guard
-- (recurring-bugs.md) being confirmed correct and in place. Root cause is the SAME class as
-- migration 1787030000000's ANALYZE fix, just the VACUUM half of it: the default
-- autovacuum_vacuum_scale_factor is 0.2 (20% of table size) before autovacuum reclaims dead
-- tuples. On a 4.18M-row table that is ~836,000 dead rows before autovacuum fires -- and
-- 813,411 is almost exactly what was measured, i.e. this table was about to cross its own
-- threshold on its own, not leaking without bound. The same write-amplification fix that cut
-- nightly churn on these tables also means it now takes much longer to accumulate enough dead
-- rows to cross a PERCENTAGE threshold, so bloat sits elevated for longer between autovacuum
-- runs on exactly the large tables where that elevated bloat costs the most (planner cost,
-- table bloat on disk, slower seq scans on the visibility map).
--
-- 1787030000000 already established scale_factor=0 with a flat threshold is the right shape for
-- these specific 8 tables (none are compressed hypertables, storage-parameter ALTER only, no
-- rewrite, no scan) -- this applies the identical treatment to the VACUUM trigger, not just
-- ANALYZE. Flat 100,000-row threshold (double the ANALYZE threshold, since a vacuum is more
-- expensive per run than an analyze and this is meant to bound worst-case bloat, not eliminate
-- all delay).
--
-- Verified live before writing this migration: manually VACUUMed marketsmojo_financials_history
-- and confirmed n_dead_tup 813,411 -> 0 in 8.5s -- the reclaim itself is cheap and safe, this
-- migration only changes how OFTEN autovacuum does it automatically.

ALTER TABLE marketsmojo_technical_history  SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);
ALTER TABLE marketsmojo_financials_history SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);
ALTER TABLE trendlyne_pb_history           SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);
ALTER TABLE trendlyne_pe_history           SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);
ALTER TABLE live_screener_appearances      SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);
ALTER TABLE live_screener_outcomes         SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);
ALTER TABLE nse_universe_history           SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);
ALTER TABLE mc_general_metrics             SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 100000);

-- Down Migration
--
-- RESET restores the cluster default (scale_factor 0.2, threshold 50). Reverting cannot lose
-- data -- it only returns these tables to the percentage-based cadence that let bloat climb to
-- 16.3% on marketsmojo_financials_history before this migration.

ALTER TABLE marketsmojo_technical_history  RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
ALTER TABLE marketsmojo_financials_history RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
ALTER TABLE trendlyne_pb_history           RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
ALTER TABLE trendlyne_pe_history           RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
ALTER TABLE live_screener_appearances      RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
ALTER TABLE live_screener_outcomes         RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
ALTER TABLE nse_universe_history           RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
ALTER TABLE mc_general_metrics             RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold);
