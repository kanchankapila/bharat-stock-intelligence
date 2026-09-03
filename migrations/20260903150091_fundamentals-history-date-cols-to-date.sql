ALTER TABLE "fundamentals_history"
    ALTER COLUMN "as_of_date" TYPE DATE USING ("as_of_date"::date);

-- 20260903150091_fundamentals-history-date-cols-to-date.sql
-- AF-20260831-04: fundamentals_history.as_of_date TEXT -> DATE (post-SQLite residue).
-- Audited fundamentals_history row-by-row: all non-NULL values are ISO-castable.
-- 109245 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
