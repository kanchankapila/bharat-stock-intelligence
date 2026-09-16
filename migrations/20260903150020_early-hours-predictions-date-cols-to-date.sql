ALTER TABLE "early_hours_predictions"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150020_early-hours-predictions-date-cols-to-date.sql
-- AF-20260831-04: early_hours_predictions.date TEXT -> DATE (post-SQLite residue).
-- Audited early_hours_predictions row-by-row: all non-NULL values are ISO-castable.
-- 500 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
