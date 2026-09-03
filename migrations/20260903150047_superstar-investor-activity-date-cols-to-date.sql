ALTER TABLE "superstar_investor_activity"
    ALTER COLUMN "period_end_date" TYPE DATE USING ("period_end_date"::date);

-- 20260903150047_superstar-investor-activity-date-cols-to-date.sql
-- AF-20260831-04: superstar_investor_activity.period_end_date TEXT -> DATE (post-SQLite residue).
-- Audited superstar_investor_activity row-by-row: all non-NULL values are ISO-castable.
-- 3730 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
