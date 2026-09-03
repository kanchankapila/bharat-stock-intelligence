ALTER TABLE "historical_fundamentals"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150086_historical-fundamentals-date-cols-to-date.sql
-- AF-20260831-04: historical_fundamentals.date TEXT -> DATE (post-SQLite residue).
-- Audited historical_fundamentals row-by-row: all non-NULL values are ISO-castable.
-- 71143 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
