-- Up Migration
--
-- 5 tables had no timestamp/date column of any kind (confirmed via information_schema.columns,
-- not assumed from db.ts) -- fetcher-accuracy-review's full-project sweep (2026-08-13) found
-- these are structurally unmeasurable by TABLE_FRESHNESS_CHECKS' standard factory, same class
-- as screener_master.last_updated being excluded from its own ON CONFLICT (fixed same session)
-- but one step further: no column existed to even attempt a fix on. Backfilled to CURRENT_TIMESTAMP
-- for existing rows (better than NULL -- a freshness check reading NULL as "never fetched" would
-- misreport rows that are actually just as old as this migration); each fetcher's own write path
-- stamps a fresh value going forward (see moneycontrol_fetcher.py / trendlyne_screener_discovery.py
-- changes in the same commit).
ALTER TABLE mc_estimates_hits_misses     ADD COLUMN IF NOT EXISTS fetched_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE mc_stock_vitals              ADD COLUMN IF NOT EXISTS fetched_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE mc_stock_scans               ADD COLUMN IF NOT EXISTS fetched_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE mc_seasonality_best_stocks   ADD COLUMN IF NOT EXISTS fetched_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE screener_catalog             ADD COLUMN IF NOT EXISTS fetched_at TEXT DEFAULT CURRENT_TIMESTAMP;

UPDATE mc_estimates_hits_misses    SET fetched_at = CURRENT_TIMESTAMP WHERE fetched_at IS NULL;
UPDATE mc_stock_vitals             SET fetched_at = CURRENT_TIMESTAMP WHERE fetched_at IS NULL;
UPDATE mc_stock_scans              SET fetched_at = CURRENT_TIMESTAMP WHERE fetched_at IS NULL;
UPDATE mc_seasonality_best_stocks  SET fetched_at = CURRENT_TIMESTAMP WHERE fetched_at IS NULL;
UPDATE screener_catalog            SET fetched_at = CURRENT_TIMESTAMP WHERE fetched_at IS NULL;

-- Down Migration
ALTER TABLE mc_estimates_hits_misses     DROP COLUMN IF EXISTS fetched_at;
ALTER TABLE mc_stock_vitals              DROP COLUMN IF EXISTS fetched_at;
ALTER TABLE mc_stock_scans               DROP COLUMN IF EXISTS fetched_at;
ALTER TABLE mc_seasonality_best_stocks   DROP COLUMN IF EXISTS fetched_at;
ALTER TABLE screener_catalog             DROP COLUMN IF EXISTS fetched_at;
