ALTER TABLE "stock_futures_oi_history"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150040_stock-futures-oi-history-date-cols-to-date.sql
-- AF-20260831-04: stock_futures_oi_history.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_futures_oi_history row-by-row: all non-NULL values are ISO-castable.
-- 2081 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
