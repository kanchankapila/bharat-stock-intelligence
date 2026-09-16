ALTER TABLE "screener_performance_history"
    ALTER COLUMN "as_of_date" TYPE DATE USING ("as_of_date"::date);

-- 20260903150078_screener-performance-history-date-cols-to-date.sql
-- AF-20260831-04: screener_performance_history.as_of_date TEXT -> DATE (post-SQLite residue).
-- Audited screener_performance_history row-by-row: all non-NULL values are ISO-castable.
-- 41332 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
