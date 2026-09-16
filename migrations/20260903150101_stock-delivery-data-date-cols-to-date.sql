ALTER TABLE "stock_delivery_data"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150101_stock-delivery-data-date-cols-to-date.sql
-- AF-20260831-04: stock_delivery_data.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_delivery_data row-by-row: all non-NULL values are ISO-castable.
-- 708097 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
