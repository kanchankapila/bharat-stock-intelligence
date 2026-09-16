ALTER TABLE "preopen_snapshot"
    ALTER COLUMN "snapshot_date" TYPE DATE USING ("snapshot_date"::date);

-- 20260903150005_preopen-snapshot-date-cols-to-date.sql
-- AF-20260831-04: preopen_snapshot.snapshot_date TEXT -> DATE (post-SQLite residue).
-- Audited preopen_snapshot row-by-row: all non-NULL values are ISO-castable.
-- 44 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
