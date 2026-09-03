ALTER TABLE "concall_takeaways"
    ALTER COLUMN "announcement_date" TYPE DATE USING ("announcement_date"::date);

-- 20260903150018_concall-takeaways-date-cols-to-date.sql
-- AF-20260831-04: concall_takeaways.announcement_date TEXT -> DATE (post-SQLite residue).
-- Audited concall_takeaways row-by-row: all non-NULL values are ISO-castable.
-- 406 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
