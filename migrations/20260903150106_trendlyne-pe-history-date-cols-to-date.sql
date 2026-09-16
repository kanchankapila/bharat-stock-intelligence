ALTER TABLE "trendlyne_pe_history"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150106_trendlyne-pe-history-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_pe_history.date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_pe_history row-by-row: all non-NULL values are ISO-castable.
-- 4151477 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
