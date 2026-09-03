ALTER TABLE "stock_corporate_action_history"
    ALTER COLUMN "announce_date" TYPE DATE USING ("announce_date"::date),
    ALTER COLUMN "record_date" TYPE DATE USING ("record_date"::date);

-- 20260903150073_stock-corporate-action-history-date-cols-to-date.sql
-- AF-20260831-04: stock_corporate_action_history.announce_date/record_date TEXT -> DATE (post-SQLite residue).
-- Audited stock_corporate_action_history row-by-row: all non-NULL values are ISO-castable.
-- 30148 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
