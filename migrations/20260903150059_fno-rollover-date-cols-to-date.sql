ALTER TABLE "fno_rollover"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150059_fno-rollover-date-cols-to-date.sql
-- AF-20260831-04: fno_rollover.date TEXT -> DATE (post-SQLite residue).
-- Audited fno_rollover row-by-row: all non-NULL values are ISO-castable.
-- 8728 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
