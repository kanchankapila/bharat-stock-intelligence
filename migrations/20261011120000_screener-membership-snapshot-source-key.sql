-- screener_id is provider-scoped: the same numeric id is issued independently by
-- MoneyControl, ETnow and Trendlyne.  The feature writer already computes with
-- (source, screener_id), but the PIT snapshot used to drop source and therefore could not
-- reproduce its own input.  Preserve old rows honestly as source-unknown; new rows carry the
-- exact provider.  This is a plain PostgreSQL table (not a Timescale hypertable).

ALTER TABLE screener_membership_snapshot
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy_unknown';

ALTER TABLE screener_membership_snapshot
  DROP CONSTRAINT IF EXISTS screener_membership_snapshot_pkey;

ALTER TABLE screener_membership_snapshot
  ADD CONSTRAINT screener_membership_snapshot_pkey
  PRIMARY KEY (as_of_date, symbol, source, screener_id);
