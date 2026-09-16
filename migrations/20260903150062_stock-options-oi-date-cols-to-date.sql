ALTER TABLE "stock_options_oi"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150062_stock-options-oi-date-cols-to-date.sql
-- AF-20260831-04: stock_options_oi.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_options_oi row-by-row: all non-NULL values are ISO-castable.
-- 9325 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
