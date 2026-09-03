ALTER TABLE "trendlyne_fno_activity"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150068_trendlyne-fno-activity-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_fno_activity.date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_fno_activity row-by-row: all non-NULL values are ISO-castable.
-- 19628 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
