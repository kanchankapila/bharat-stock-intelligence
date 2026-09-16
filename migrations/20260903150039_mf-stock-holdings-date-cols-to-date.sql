ALTER TABLE "mf_stock_holdings"
    ALTER COLUMN "as_of_date" TYPE DATE USING ("as_of_date"::date);

-- 20260903150039_mf-stock-holdings-date-cols-to-date.sql
-- AF-20260831-04: mf_stock_holdings.as_of_date TEXT -> DATE (post-SQLite residue).
-- Audited mf_stock_holdings row-by-row: all non-NULL values are ISO-castable.
-- 2071 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
