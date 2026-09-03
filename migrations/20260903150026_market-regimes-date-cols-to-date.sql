ALTER TABLE "market_regimes"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150026_market-regimes-date-cols-to-date.sql
-- AF-20260831-04: market_regimes.date TEXT -> DATE (post-SQLite residue).
-- Audited market_regimes row-by-row: all non-NULL values are ISO-castable.
-- 707 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
