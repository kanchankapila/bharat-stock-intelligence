-- unified_recommendations.computed_at is a bare TEXT DATE and the upsert key is
-- (symbol, computed_at), so a manual same-day re-run silently overwrites that day's 07:30
-- IST cron row with no trace. Nothing recorded WHEN a row was actually produced, so a
-- genuine pre-market signal and a post-close re-run were indistinguishable -- which makes
-- the canonical ranking table ungradeable: measuring a session against a row that may have
-- been computed after that session closed is look-ahead, and there was no way to tell.
--
-- generated_at records the wall-clock instant of the run that produced the row. It is
-- deliberately NOT part of the key: adding it would create multiple snapshots per day and
-- change what "the latest snapshot" means for every consumer of this table.
--
-- Existing rows are left NULL on purpose -- their true generation time is genuinely unknown
-- and NULL is honest, where backfilling computed_at::timestamptz would fabricate a
-- precise-looking 00:00 that measurement code would then trust.
ALTER TABLE unified_recommendations
    ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;

COMMENT ON COLUMN unified_recommendations.generated_at IS
    'Wall-clock UTC instant of the run that produced this row. NULL = pre-2026-08-10, unknown.
     A re-run REPLACES the row, so this reflects the LAST run for (symbol, computed_at), not
     the first. To keep only genuinely pre-market rows when grading a session, require
     generated_at < computed_at 03:45 UTC (NSE opens 09:15 IST = 03:45 UTC); anything later
     was computed during or after the session it would be graded against.';

CREATE INDEX IF NOT EXISTS idx_ur_generated_at
    ON unified_recommendations (computed_at, generated_at);
