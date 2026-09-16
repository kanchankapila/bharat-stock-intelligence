ALTER TABLE "stock_delivery_volume"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150093_stock-delivery-volume-date-cols-to-date.sql
-- AF-20260831-04: stock_delivery_volume.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_delivery_volume row-by-row: all non-NULL values are ISO-castable.
-- 162625 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
