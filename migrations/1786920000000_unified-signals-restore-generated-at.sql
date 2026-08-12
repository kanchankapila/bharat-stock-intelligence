-- Up Migration
--
-- unified_signals.signal_generated_at was in the ON CONFLICT DO UPDATE SET of all three of its
-- writers (signals.ts's upsertUnifiedSignal, technicalSignalsService.ts's unifiedUpsertSql, and
-- technical_analysis_engine.py), so every re-run of a scan walked the stamp forward. The column
-- is supposed to answer "when was this signal first generated" -- the only fact able to
-- establish that a signal predates the bar it is graded against -- and instead it recorded
-- "when was this row last refreshed".
--
-- Measured live 2026-08-12 before this migration: 29,433 of 55,736 rows carried a
-- signal_generated_at LATER than their own created_at, which is impossible if the column meant
-- what its name says. 100% of signal_source='technical' rows (19,480) were affected, drifting up
-- to 24h; 57% of 'TECHNICAL'; 23% of 'AI'. Effect on measurement: only 1,320 rows (2.4%) looked
-- like they were generated before the open of the signal_date they claim, when the true figure
-- from created_at is 9,931 (17.8%) -- so the platform's own accuracy reviews were grading ~2% of
-- its output and treating the rest as unusable.
--
-- created_at is the correct repair anchor: it DEFAULTs to now() at insert and appears in none of
-- the three writers' update lists, so it still holds the original first-write time. Where a row
-- was never re-run the two columns already agree and the WHERE clause skips it.
--
-- The 60-second slack absorbs the ordinary gap between the application building its timestamp
-- and Postgres evaluating the row DEFAULT; without it this rewrites tens of thousands of rows by
-- milliseconds for no benefit.
--
-- unified_signals is NOT a TimescaleDB hypertable (verified against
-- timescaledb_information.hypertables on the live DB), so this predicate-wide UPDATE is safe and
-- will not decompress or fail the way it would on stock_ohlcv.
--
-- Deliberately NOT reversible: the down migration cannot reconstruct the drifted values, and
-- would not want to -- they were wrong. Restoring them would re-break provenance.

UPDATE unified_signals
   SET signal_generated_at = created_at
 WHERE created_at IS NOT NULL
   AND created_at < signal_generated_at - interval '60 seconds';

-- Down Migration
-- No-op. The prior values were corrupt (a last-refresh time in a first-generation column) and
-- are not recoverable from any other column. Rolling back would reintroduce the defect.
SELECT 1;
