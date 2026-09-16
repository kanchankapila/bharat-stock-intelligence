ALTER TABLE "mc_global_snapshot"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150038_mc-global-snapshot-date-cols-to-date.sql
-- AF-20260831-04: mc_global_snapshot.date TEXT -> DATE (post-SQLite residue).
-- Audited mc_global_snapshot row-by-row: all non-NULL values are ISO-castable.
-- 1981 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
