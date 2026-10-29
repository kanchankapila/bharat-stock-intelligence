-- AF-20261025-01 shadow arm: the repaired intraday screener score, recorded beside the live one
-- (which is a constant 50) and never blended, so ~20 sessions can grade it before any weight moves.
-- A nullable ADD COLUMN is a catalog-only change.
SET LOCAL lock_timeout = '5s';
ALTER TABLE intraday_recommendations_history ADD COLUMN IF NOT EXISTS screener_score_shadow double precision;
