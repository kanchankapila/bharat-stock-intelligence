ALTER TABLE "market_holidays"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150010_market-holidays-date-cols-to-date.sql
-- AF-20260831-04: market_holidays.date TEXT -> DATE (post-SQLite residue).
-- Audited market_holidays row-by-row: all non-NULL values are ISO-castable.
-- 75 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
