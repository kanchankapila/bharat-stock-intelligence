-- Up Migration
--
-- Completes migration 1786930000000, which renamed signal_source 'TECHNICAL' -> 'technical_scan'
-- in unified_signals and unified_signal_outcomes but MISSED signal_source_weights. Five tables in
-- this schema carry a signal_source column; that migration hand-enumerated two, so
-- signal_source_weights kept both 'technical' (45 rows) and 'TECHNICAL' (44) and the collision
-- survived in the one table whose whole purpose is per-source learning.
--
-- The companion data-quality check added alongside that migration had the same defect and
-- reported PASS, because its UNION also hand-listed the same two tables. Both are fixed here and
-- in dataQualityChecks.ts: the check now covers all five tables AND a second check fails if a
-- sixth table with a signal_source column ever appears without being added to it. Same lesson as
-- screenerAppearedAt.test.ts in recurring-bugs.md -- a guard built on a hand-enumerated allowlist
-- only guards what someone remembered to list, and the omitted writer is never the small one.
--
-- signal_source_weights is written by reward_engine.update_source_weights(), whose upsert key is
-- (signal_source, regime, sector). Verified against production before writing: zero
-- 'technical_scan' rows exist there, and zero (regime, sector) pairs exist under both spellings,
-- so the rename cannot violate that key.

UPDATE signal_source_weights
   SET signal_source = 'technical_scan'
 WHERE signal_source = 'TECHNICAL';

-- Down Migration
UPDATE signal_source_weights
   SET signal_source = 'TECHNICAL'
 WHERE signal_source = 'technical_scan';
