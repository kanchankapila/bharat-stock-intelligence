-- Up Migration
--
-- screener_performance_history (the point-in-time bayesian_score snapshot table added
-- 2026-07-31) has PRIMARY KEY (screener_id, as_of_date) with no source column at all --
-- already flagged as a "KNOWN REMAINING GAP" in screener_features_fetcher.py's
-- load_screener_meta() docstring when the sibling screener_master/screener_reliability/
-- screener_performance_v2 tables were fixed to (source, scan_id)/(screener_id, source)
-- 2026-08-04/05. For the 20 screener_ids that collide across providers (confirmed live via
-- screener_appearances), this table's compute_pit_scores() grouped resolved appearances from
-- BOTH providers into one blended win-rate/bayesian_score/tier under a single row, and
-- load_screener_meta()'s PIT read (keyed on bare screener_id) could apply that blended score
-- -- or the wrong provider's entirely -- to either provider's screener_momentum_score feature,
-- the largest single engine weight in most of unified_ranker.py's REGIME_WEIGHTS regimes.
--
-- Confirmed live 2026-08-05: 12364 total rows, 180 belonging to the 20 colliding
-- screener_ids, 0 rows whose screener_id is entirely absent from screener_appearances.
--
-- Backfill: for the ~12184 non-colliding rows, source is recoverable exactly (each
-- screener_id maps to exactly one source in screener_appearances). For the 180 rows on
-- colliding screener_ids, the underlying bayesian_score/wr_20d/alpha_20d values were already
-- computed by BLENDING both providers' resolved appearances at write time -- there is no way
-- to retroactively split that back into two clean per-provider scores, so (matching this
-- project's established precedent for irrecoverably-corrupted historical data -- e.g. the
-- 2026-07-23 URL-as-symbol purge) those 180 rows are deleted rather than kept under a
-- guessed/duplicated source. load_screener_meta() already falls back safely to the current
-- full-sample screener_performance_v2 score when no PIT snapshot exists for a screener/date,
-- so deleting rather than mis-tagging is the safe direction here.
DELETE FROM screener_performance_history
WHERE screener_id IN (
  SELECT screener_id FROM screener_appearances
  GROUP BY screener_id HAVING COUNT(DISTINCT source) > 1
);

ALTER TABLE screener_performance_history ADD COLUMN source TEXT;

UPDATE screener_performance_history sph
SET source = sa.source
FROM (SELECT DISTINCT screener_id, source FROM screener_appearances) sa
WHERE sa.screener_id = sph.screener_id;

-- Any row whose screener_id never appeared in screener_appearances at all (shouldn't exist
-- per the live count above, but a stale/orphaned row is possible after further data changes
-- before this migration actually runs) has no source to backfill and cannot be kept under the
-- NOT NULL constraint below -- same reasoning as the DELETE above: drop rather than guess.
DELETE FROM screener_performance_history WHERE source IS NULL;

ALTER TABLE screener_performance_history ALTER COLUMN source SET NOT NULL;
ALTER TABLE screener_performance_history DROP CONSTRAINT IF EXISTS screener_performance_history_pkey;
ALTER TABLE screener_performance_history ADD PRIMARY KEY (source, screener_id, as_of_date);

-- Down Migration
--
-- NOTE: will fail once any provider has written a PIT snapshot for a colliding screener_id
-- under the new schema (the table would then hold 2+ rows sharing (screener_id, as_of_date)
-- under different sources) -- same caveat as every other source-widening migration in this
-- series.
ALTER TABLE screener_performance_history DROP CONSTRAINT IF EXISTS screener_performance_history_pkey;
ALTER TABLE screener_performance_history ADD PRIMARY KEY (screener_id, as_of_date);
ALTER TABLE screener_performance_history DROP COLUMN source;
