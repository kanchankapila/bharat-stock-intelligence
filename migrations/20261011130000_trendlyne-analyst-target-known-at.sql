-- AF-20261008-13(e): reco_date is the report's event date, not when this
-- installation learned about it.  Preserve an immutable availability time so
-- historical features cannot see reports before the first local observation.
ALTER TABLE trendlyne_analyst_targets
  ADD COLUMN IF NOT EXISTS known_at TIMESTAMPTZ;

-- fetched_at was overwritten on every refresh.  It is therefore later than or
-- equal to first observation and is a conservative (no-look-ahead) seed.
UPDATE trendlyne_analyst_targets
SET known_at = fetched_at::timestamptz
WHERE known_at IS NULL;

ALTER TABLE trendlyne_analyst_targets
  ALTER COLUMN known_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN known_at SET NOT NULL;

COMMENT ON COLUMN trendlyne_analyst_targets.known_at IS
  'Immutable local availability time; use with reco_date for point-in-time features.';
