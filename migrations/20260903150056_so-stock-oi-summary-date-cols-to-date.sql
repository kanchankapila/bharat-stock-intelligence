ALTER TABLE "so_stock_oi_summary"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150056_so-stock-oi-summary-date-cols-to-date.sql
-- AF-20260831-04: so_stock_oi_summary.date TEXT -> DATE (post-SQLite residue).
-- Audited so_stock_oi_summary row-by-row: all non-NULL values are ISO-castable.
-- 6921 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
