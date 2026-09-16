-- Up Migration
--
-- trendlyne_screener_discovery.py's upsert_screener() keys trendlyne_screeners on
-- screener_id = name.lower().replace(' ', '-')... -- a slug derived from the screener's NAME,
-- not its numeric screenpk. Trendlyne periodically reassigns a new screenpk to the same
-- logical screener as it refreshes its own catalog; KNOWN_PKS accumulates both the old and
-- the new pk over time, and since both resolve to the identical screener_id, whichever one
-- sync_pks() processes last (via a concurrent ThreadPoolExecutor -- not even a stable batch
-- order) silently overwrites trendlyne_screeners.screenpk. The OLD pk then vanishes with no
-- error, no skip logged, nothing to distinguish it from a screener that was never captured
-- at all. Found 2026-08-13 (see .claude/rules/recurring-bugs.md, "An upsert keyed on a
-- derived value... silently discards the provider's id on every re-derivation" -- 9 real pks
-- traced, e.g. 16 -> 82476, 30 -> 422013), left deliberately unfixed pending "track pk
-- history, neither implemented".
--
-- This is that implementation. trendlyne_screeners.screenpk stays the CURRENT pk (downstream
-- fetchers need exactly one to hit) -- this table is additive, recording every pk ever seen
-- for a screener_id so "is pk X captured" no longer silently loses history to overwrite order.

CREATE TABLE IF NOT EXISTS trendlyne_screener_pk_history (
  screener_id TEXT NOT NULL,
  screenpk    TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (screener_id, screenpk)
);

COMMENT ON TABLE trendlyne_screener_pk_history IS
  'Every (screener_id, screenpk) pair upsert_screener() has ever synced, so a pk reassigned by '
  'Trendlyne stays discoverable after trendlyne_screeners.screenpk is overwritten by a newer '
  'one. See recurring-bugs.md''s screener-pk-collision entry.';

CREATE INDEX IF NOT EXISTS idx_trendlyne_screener_pk_history_screenpk
  ON trendlyne_screener_pk_history (screenpk);

-- Down Migration
DROP TABLE IF EXISTS trendlyne_screener_pk_history;
