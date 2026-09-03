ALTER TABLE "stock_earnings_dates"
    ALTER COLUMN "result_date" TYPE DATE USING ("result_date"::date);

-- 20260903150048_stock-earnings-dates-date-cols-to-date.sql
-- AF-20260831-04: stock_earnings_dates.result_date TEXT -> DATE (post-SQLite residue).
-- Audited stock_earnings_dates row-by-row: all non-NULL values are ISO-castable.
-- 3752 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
