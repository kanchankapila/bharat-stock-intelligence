-- Up Migration
--
-- How many independent component scorers (screener/ml/cs/confluence/technical/dl/breakout)
-- actually had data for this symbol when unified_ranker.py's _blend() renormalized weights.
-- A score built from 2 of 7 engines and one built from 7 of 7 must not look identical
-- downstream -- this exposes that distinction. Nullable, additive only.
ALTER TABLE unified_recommendations ADD COLUMN IF NOT EXISTS engine_coverage_count INTEGER;

-- Down Migration
ALTER TABLE unified_recommendations DROP COLUMN IF EXISTS engine_coverage_count;