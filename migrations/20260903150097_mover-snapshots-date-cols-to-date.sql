ALTER TABLE "mover_snapshots"
    ALTER COLUMN "trade_date" TYPE DATE USING ("trade_date"::date);

-- 20260903150097_mover-snapshots-date-cols-to-date.sql
-- AF-20260831-04: mover_snapshots.trade_date TEXT -> DATE (post-SQLite residue).
-- Audited mover_snapshots row-by-row: all non-NULL values are ISO-castable.
-- 391095 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
