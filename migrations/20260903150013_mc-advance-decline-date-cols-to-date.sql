ALTER TABLE "mc_advance_decline"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150013_mc-advance-decline-date-cols-to-date.sql
-- AF-20260831-04: mc_advance_decline.date TEXT -> DATE (post-SQLite residue).
-- Audited mc_advance_decline row-by-row: all non-NULL values are ISO-castable.
-- 94 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
