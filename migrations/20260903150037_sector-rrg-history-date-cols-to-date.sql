ALTER TABLE "sector_rrg_history"
    ALTER COLUMN "week_date" TYPE DATE USING ("week_date"::date);

-- 20260903150037_sector-rrg-history-date-cols-to-date.sql
-- AF-20260831-04: sector_rrg_history.week_date TEXT -> DATE (post-SQLite residue).
-- Audited sector_rrg_history row-by-row: all non-NULL values are ISO-castable.
-- 1635 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
