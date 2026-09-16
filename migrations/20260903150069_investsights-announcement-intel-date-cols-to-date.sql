ALTER TABLE "investsights_announcement_intel"
    ALTER COLUMN "announcement_date" TYPE DATE USING ("announcement_date"::date);

-- 20260903150069_investsights-announcement-intel-date-cols-to-date.sql
-- AF-20260831-04: investsights_announcement_intel.announcement_date TEXT -> DATE (post-SQLite residue).
-- Audited investsights_announcement_intel row-by-row: all non-NULL values are ISO-castable.
-- 22098 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
