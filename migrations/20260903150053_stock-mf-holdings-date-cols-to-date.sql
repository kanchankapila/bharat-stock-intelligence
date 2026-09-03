ALTER TABLE "stock_mf_holdings"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150053_stock-mf-holdings-date-cols-to-date.sql
-- AF-20260831-04: stock_mf_holdings.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_mf_holdings row-by-row: all non-NULL values are ISO-castable.
-- 5616 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
