ALTER TABLE "high_flyer_retrospective"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150000_high-flyer-retrospective-date-cols-to-date.sql
-- AF-20260831-04: high_flyer_retrospective.date TEXT -> DATE (post-SQLite residue).
-- Audited high_flyer_retrospective row-by-row: all non-NULL values are ISO-castable.
-- 0 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
