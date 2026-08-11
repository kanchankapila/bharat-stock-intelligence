-- Record WHEN a screener actually flagged a symbol, not just the date.
--
-- Found 2026-08-11: screener_appearances.appeared_date is TIMESTAMPTZ but all 720,824 rows
-- carry exactly ONE distinct time, 00:00:00. The capture moment has never been recorded, so
-- the only question a daily screener snapshot can answer is "does yesterday's gainer keep
-- going" (measured: it does not -- +0.003pp next session, t=+0.13, and -0.106pp t=-2.03 for
-- momentum screeners).
--
-- The question that is actually open -- enter at the moment of flagging, exit at that day's
-- close -- is unmeasurable without a capture time. That matters because these lists ARE
-- same-day: members show +0.500pp same-day excess (t=+12.70), +0.990pp (t=+9.24) for
-- technical_momentum. The price side is already there: intraday_ohlcv holds 15-minute bars
-- for 2,353 symbols over 215 days.
--
-- A NEW column, deliberately, rather than putting a real time into appeared_date:
-- appeared_date is part of the primary key (screener_id, symbol, appeared_date), so a real
-- timestamp there would stop a repeat appearance on the same day from deduping and would
-- multiply the table by the sync frequency.
--
-- Existing rows stay NULL on purpose. Their true capture time is unknown and backfilling
-- appeared_date::timestamptz would fabricate a precise-looking 00:00 that measurement code
-- would then trust -- the same mistake unified_recommendations.generated_at avoided.

ALTER TABLE screener_appearances
  ADD COLUMN IF NOT EXISTS appeared_at TIMESTAMPTZ;

COMMENT ON COLUMN screener_appearances.appeared_at IS
  'Wall-clock instant the sync observed this symbol on this screener. NULL for rows written
   before 2026-08-11, whose capture time was never recorded and must not be inferred.
   Deliberately NOT in the primary key -- (screener_id, symbol, appeared_date) stays the dedup
   key so a repeat appearance on the same day still collapses to one row; appeared_at records
   the FIRST observation of that day (INSERT OR IGNORE keeps the first write).
   Use this, never appeared_date, to measure an intraday screener entry: join to
   intraday_ohlcv on the 15-minute bar containing appeared_at.';

CREATE INDEX IF NOT EXISTS idx_sa_appeared_at
  ON screener_appearances (appeared_at)
  WHERE appeared_at IS NOT NULL;
