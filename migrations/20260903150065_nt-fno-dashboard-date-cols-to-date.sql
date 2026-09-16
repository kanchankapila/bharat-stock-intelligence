ALTER TABLE "nt_fno_dashboard"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150065_nt-fno-dashboard-date-cols-to-date.sql
-- AF-20260831-04: nt_fno_dashboard.date TEXT -> DATE (post-SQLite residue).
-- Audited nt_fno_dashboard row-by-row: all non-NULL values are ISO-castable.
-- 10018 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
