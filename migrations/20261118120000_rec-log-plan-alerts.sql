-- AF-20261117-15: recPlanAlerts.ts sends one intraday Telegram alert per stop/target touch on an
-- open recommendation_log plan. These stamps make each event alert once; NULL = not yet alerted.
-- Metadata-only ADD COLUMN (nullable, no default): no table rewrite.
SET LOCAL lock_timeout = '5s';

ALTER TABLE recommendation_log ADD COLUMN IF NOT EXISTS stop_alerted_at TIMESTAMPTZ;
ALTER TABLE recommendation_log ADD COLUMN IF NOT EXISTS target_alerted_at TIMESTAMPTZ;
