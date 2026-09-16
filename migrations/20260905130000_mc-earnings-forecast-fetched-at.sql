-- Up Migration
--
-- mc_earnings_forecast had NO ingestion timestamp at all, so its freshness check
-- (mc-earnings-forecast-freshness, dataQualityChecks.ts) was pointed at `date` -- which is not
-- an ingestion date. That column is TEXT holding FISCAL PERIOD labels ('Mar 2026', 'Mar 2029',
-- 'Sep 2026', 19 distinct values). max(date) on it is therefore LEXICOGRAPHIC, not chronological:
-- it returns 'Sep 2026' because 'S' > 'M', which the check then parses as 2026-09-01 and reports
-- as "4.1 days old".
--
-- That number measures nothing about whether the fetcher ran. Worse, it is a constant that drifts
-- by exactly one day per day: measured 2026-09-05 it read 4.1 days against warnDays 3 / failDays 5,
-- so it was due to flip to a PERMANENT fail the next day and stay there until the fiscal label
-- happened to roll. A check that cannot pass is the same defect class as one that cannot fail --
-- see ml-model-bugs.md's drift_detector entry.
--
-- fetched_at matches the pattern its four moneycontrol_fetcher.py siblings already got in
-- migration 1786990000000 (mc_estimates_hits_misses, mc_stock_vitals, mc_stock_scans,
-- mc_seasonality_best_stocks) -- same fetcher, same crawl, same TEXT/CURRENT_TIMESTAMP shape,
-- so the checks stay consistent with each other.
--
-- NOTE ON SEMANTICS: fetched_at IS included in the fetcher's ON CONFLICT DO UPDATE list, making
-- it a LAST-SEEN time rather than a first-written time. recurring-bugs.md warns against exactly
-- that for a PROVENANCE column ("a generated-at column listed in ON CONFLICT DO UPDATE stops
-- being a generation time"), but last-seen is precisely the semantic a freshness check needs --
-- "did the fetcher touch this recently" -- so it is deliberate here, not the bug. Do not use this
-- column to date when a forecast was first published.

ALTER TABLE mc_earnings_forecast ADD COLUMN IF NOT EXISTS fetched_at TEXT DEFAULT CURRENT_TIMESTAMP;

COMMENT ON COLUMN mc_earnings_forecast.fetched_at IS
  'LAST-SEEN ingestion timestamp (updated on every upsert), used by the '
  'mc-earnings-forecast-freshness data-quality check. NOT a publication date: the `date` column '
  'holds fiscal period labels (''Mar 2026'') and is unusable for freshness -- max() on it is '
  'lexicographic. See migration 20260905130000 and AF-20260905-13.';

-- Down Migration
ALTER TABLE mc_earnings_forecast DROP COLUMN IF EXISTS fetched_at;
