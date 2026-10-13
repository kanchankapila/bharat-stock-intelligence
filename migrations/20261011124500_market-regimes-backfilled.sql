-- AF-20261008-13(f): distinguish the one in-sample historical regime load from
-- point-in-time daily labels.  Measurements must exclude the former.
ALTER TABLE market_regimes
  ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE market_regimes
SET backfilled = TRUE
WHERE date < DATE '2026-08-10'
  AND backfilled IS DISTINCT FROM TRUE;

COMMENT ON COLUMN market_regimes.backfilled IS
  'True when the label was reconstructed after the fact; false for point-in-time daily writes.';
