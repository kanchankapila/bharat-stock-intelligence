ALTER TABLE "market_breadth"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150036_market-breadth-date-cols-to-date.sql
-- AF-20260831-04: market_breadth.date TEXT -> DATE (post-SQLite residue).
-- Audited market_breadth row-by-row: all non-NULL values are ISO-castable.
-- 1416 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
