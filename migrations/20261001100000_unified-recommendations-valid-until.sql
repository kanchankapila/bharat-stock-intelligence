-- AF-20261001-04 (structural half): unified_recommendations had no valid_until.
--
-- A recommendation carried a horizon LABEL (timeframe: INTRADAY/SWING/POSITIONAL) but no
-- machine-readable statement of when the idea stopped being actionable. Nothing could answer
-- "is this still live?", so every consumer invented its own expiry -- Telegram showed a
-- 5-week-old POSITIONAL call next to a fresh one, and the grading windows were chosen by
-- whichever resolver pass happened to run rather than by the label on the row.
--
-- The session counts are NOT new windows. They are the horizons the resolvers already grade at
-- ({1,5,15} sessions), so making the label select among them keeps every existing measurement
-- corpus directly comparable instead of re-basing the numbers:
--
--   INTRADAY   -> 1 session   (same session as the signal; the intraday resolver's own window)
--   SWING      -> 5 sessions  (the 5d outcome horizon)
--   POSITIONAL -> 15 sessions (the 15d outcome horizon)
--
-- A NULL/UNKNOWN timeframe gets a NULL valid_until rather than a default. 68,520 of 74,180
-- historical rows have timeframe IS NULL (measured 2026-10-01) -- inventing a 15-session
-- validity for a row that never declared its horizon would assert a claim the data does not
-- support, and would let an expiry sweep close rows on an invented deadline. NULL is honest
-- and means "unknown validity", which is exactly what those rows are.

-- ── Exact NSE session arithmetic ────────────────────────────────────────────────────────────
-- generate_series over the calendar, minus weekends, minus market_holidays (NSE), then take
-- the Nth survivor. Deliberately NOT calendar-day arithmetic: a 5-session window is 7 calendar
-- days, but over a Diwali week it is 12, and a calendar-day approximation would set
-- valid_until BEFORE the idea's own window had elapsed.
--
-- generate_series has no (date, date) overload -- only (timestamp, timestamp) and (int, int).
-- Casting through timestamp and back is what makes this resolve; passing the dates directly
-- fails with 42883 and the migrate harness rolls the whole file back.
CREATE OR REPLACE FUNCTION bharat_add_sessions(d date, n integer)
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT s.ts::date
  FROM (
    SELECT g.ts,
           row_number() OVER (ORDER BY g.ts) AS rn
    FROM generate_series((d + 1)::timestamp, (d + 60)::timestamp, interval '1 day') AS g(ts)
    WHERE extract(isodow FROM g.ts) <= 5
      AND NOT EXISTS (
        SELECT 1 FROM market_holidays m
        WHERE m.exchange = 'NSE' AND m.date = g.ts::date
      )
  ) s
  WHERE s.rn = n
$$;

COMMENT ON FUNCTION bharat_add_sessions(date, integer) IS
  'The n-th NSE trading session strictly after date d (weekends + market_holidays excluded). '
  'Returns NULL if fewer than n sessions exist in the 60-calendar-day horizon.';

ALTER TABLE unified_recommendations ADD COLUMN IF NOT EXISTS valid_until timestamptz;

-- Backfill. Normalizes the same alias families the ranker folds onto the canonical three
-- (unified_ranker._TIMEFRAME_ALIASES), so 'Long term'/'LONG_TERM' get the POSITIONAL deadline
-- they always meant instead of being skipped as unknown. The space-separated spellings are
-- listed alongside the underscored ones for the same reason _TIMEFRAME_ALIASES_COLLAPSED
-- exists on the Python side: 'Long term' uppercases to 'LONG TERM', a different string from
-- 'LONG_TERM', and would otherwise fall through to the NULL branch.
UPDATE unified_recommendations
SET valid_until = (bharat_add_sessions(
        (generated_at AT TIME ZONE 'Asia/Kolkata')::date,
        CASE
          WHEN upper(btrim(timeframe)) IN ('INTRADAY') THEN 1
          WHEN upper(btrim(timeframe)) IN ('SWING', 'SHORT TERM', 'SHORT_TERM',
                                           'SWING (3-7D)') THEN 5
          WHEN upper(btrim(timeframe)) IN ('POSITIONAL', 'LONG TERM', 'LONG_TERM',
                                           'POSITIONAL (2-4W)', 'POSITIONAL (1-3M)') THEN 15
          ELSE NULL
        END
      ) AT TIME ZONE 'Asia/Kolkata')
WHERE timeframe IS NOT NULL
  AND btrim(timeframe) <> ''
  AND valid_until IS NULL
  AND generated_at IS NOT NULL;

-- The expiry sweep's access path: "active rows whose deadline has passed", and the freshness
-- bounds the read surfaces now apply.
CREATE INDEX IF NOT EXISTS idx_unified_recommendations_valid_until
  ON unified_recommendations (valid_until)
  WHERE valid_until IS NOT NULL;
