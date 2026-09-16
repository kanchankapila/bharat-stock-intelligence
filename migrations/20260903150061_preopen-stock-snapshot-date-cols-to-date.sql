ALTER TABLE "preopen_stock_snapshot"
    ALTER COLUMN "snapshot_date" TYPE DATE USING ("snapshot_date"::date);

-- 20260903150061_preopen-stock-snapshot-date-cols-to-date.sql
-- AF-20260831-04: preopen_stock_snapshot.snapshot_date TEXT -> DATE (post-SQLite residue).
-- Audited preopen_stock_snapshot row-by-row: all non-NULL values are ISO-castable.
-- 9201 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
