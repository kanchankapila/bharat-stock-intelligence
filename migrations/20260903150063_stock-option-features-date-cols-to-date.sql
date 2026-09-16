ALTER TABLE "stock_option_features"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150063_stock-option-features-date-cols-to-date.sql
-- AF-20260831-04: stock_option_features.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_option_features row-by-row: all non-NULL values are ISO-castable.
-- 9549 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
