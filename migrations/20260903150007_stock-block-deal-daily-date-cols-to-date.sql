ALTER TABLE "stock_block_deal_daily"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150007_stock-block-deal-daily-date-cols-to-date.sql
-- AF-20260831-04: stock_block_deal_daily.date TEXT -> DATE (post-SQLite residue).
-- Audited stock_block_deal_daily row-by-row: all non-NULL values are ISO-castable.
-- 55 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
