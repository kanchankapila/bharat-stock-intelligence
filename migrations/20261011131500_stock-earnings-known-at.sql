-- AF-20261008-13(d): retain when an earnings date first became locally
-- knowable. fetched_at remains the last sighting and therefore bounds the
-- validity of a date that later disappears after a reschedule.
ALTER TABLE stock_earnings_dates
  ADD COLUMN IF NOT EXISTS known_at TIMESTAMPTZ;

-- Historical first-observation timestamps were overwritten.  The last sighting
-- is a conservative seed: it may omit old information but cannot leak it early.
UPDATE stock_earnings_dates
SET known_at = fetched_at::timestamptz
WHERE known_at IS NULL;

ALTER TABLE stock_earnings_dates
  ALTER COLUMN known_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN known_at SET NOT NULL;

COMMENT ON COLUMN stock_earnings_dates.known_at IS
  'Immutable local first-observation time; fetched_at is the latest sighting.';
