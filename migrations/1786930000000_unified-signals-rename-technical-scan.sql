-- Up Migration
--
-- unified_signals.signal_source carried BOTH 'technical' (technical_analysis_engine.py, 19,482
-- rows) and 'TECHNICAL' (technicalSignalsService.ts, 5,922 rows) -- two different producers whose
-- source values differed only by case. unified_signal_outcomes inherited the same split
-- ('technical' 25,740 / 'TECHNICAL' 16,589).
--
-- That is not cosmetic. reward_engine.py's update_weights() excludes technical-sourced rows from
-- the unified_signal_outcomes half of its UNION (they already arrive via the signal_outcomes
-- half) and the exclusion read `NOT IN ('TECHNICAL')`. When Cluster B-lite folded
-- technical_analysis_engine.py into unified_signals under the LOWERCASE spelling, that exclusion
-- silently stopped covering it -- 25,740 rows began passing a filter written to stop them, and
-- nothing errored. Fixed in the same commit to `NOT IN ('technical', 'technical_scan')`.
--
-- 'technical_scan' matches the `source` technicalSignalsService.ts already writes to
-- recommendation_log for the very same scan, so this removes the collision rather than inventing
-- a third name.
--
-- Collision check run against production before writing this: zero existing rows use
-- 'technical_scan', and zero (symbol, signal_type, signal_date) tuples exist under both
-- 'TECHNICAL' and 'technical_scan', so the rename cannot violate
-- unified_signals' (symbol, signal_source, signal_type, signal_date) unique key.
--
-- Neither table is a TimescaleDB hypertable, so these predicate-wide UPDATEs are safe.
--
-- NOTE: 'technical' (lowercase) is deliberately left alone. It is a genuinely different
-- producer, not a duplicate spelling of this one -- collapsing the two would merge two distinct
-- engines' signals under one source and break the outcome attribution that
-- scoring-authority.md's signal_source work exists to provide.

UPDATE unified_signals
   SET signal_source = 'technical_scan'
 WHERE signal_source = 'TECHNICAL';

UPDATE unified_signal_outcomes
   SET signal_source = 'technical_scan'
 WHERE signal_source = 'TECHNICAL';

-- Down Migration
UPDATE unified_signals
   SET signal_source = 'TECHNICAL'
 WHERE signal_source = 'technical_scan';

UPDATE unified_signal_outcomes
   SET signal_source = 'TECHNICAL'
 WHERE signal_source = 'technical_scan';
