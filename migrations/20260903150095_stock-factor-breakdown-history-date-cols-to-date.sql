ALTER TABLE "stock_factor_breakdown_history"
    ALTER COLUMN "snapshot_date" TYPE DATE USING ("snapshot_date"::date);

-- 20260903150095_stock-factor-breakdown-history-date-cols-to-date.sql
-- AF-20260831-04: stock_factor_breakdown_history.snapshot_date TEXT -> DATE (post-SQLite residue).
-- Audited stock_factor_breakdown_history row-by-row: all non-NULL values are ISO-castable.
-- 299881 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
