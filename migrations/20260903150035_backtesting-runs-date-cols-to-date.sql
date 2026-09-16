ALTER TABLE "backtesting_runs"
    ALTER COLUMN "end_date" TYPE DATE USING ("end_date"::date),
    ALTER COLUMN "start_date" TYPE DATE USING ("start_date"::date);

-- 20260903150035_backtesting-runs-date-cols-to-date.sql
-- AF-20260831-04: backtesting_runs.end_date/start_date TEXT -> DATE (post-SQLite residue).
-- Audited backtesting_runs row-by-row: all non-NULL values are ISO-castable.
-- 1232 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
