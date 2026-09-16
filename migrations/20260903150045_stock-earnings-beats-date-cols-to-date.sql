ALTER TABLE "stock_earnings_beats"
    ALTER COLUMN "quarter_date" TYPE DATE USING ("quarter_date"::date);

-- 20260903150045_stock-earnings-beats-date-cols-to-date.sql
-- AF-20260831-04: stock_earnings_beats.quarter_date TEXT -> DATE (post-SQLite residue).
-- Audited stock_earnings_beats row-by-row: all non-NULL values are ISO-castable.
-- 2862 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
