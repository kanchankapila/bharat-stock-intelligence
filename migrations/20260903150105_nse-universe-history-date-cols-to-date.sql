ALTER TABLE "nse_universe_history"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150105_nse-universe-history-date-cols-to-date.sql
-- AF-20260831-04: nse_universe_history.date TEXT -> DATE (post-SQLite residue).
-- Audited nse_universe_history row-by-row: all non-NULL values are ISO-castable.
-- 3325500 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
