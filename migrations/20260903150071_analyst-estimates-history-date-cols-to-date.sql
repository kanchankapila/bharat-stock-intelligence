ALTER TABLE "analyst_estimates_history"
    ALTER COLUMN "as_of_date" TYPE DATE USING ("as_of_date"::date);

-- 20260903150071_analyst-estimates-history-date-cols-to-date.sql
-- AF-20260831-04: analyst_estimates_history.as_of_date TEXT -> DATE (post-SQLite residue).
-- Audited analyst_estimates_history row-by-row: all non-NULL values are ISO-castable.
-- 24516 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
