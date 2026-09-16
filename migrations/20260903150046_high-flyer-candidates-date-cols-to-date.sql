ALTER TABLE "high_flyer_candidates"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150046_high-flyer-candidates-date-cols-to-date.sql
-- AF-20260831-04: high_flyer_candidates.date TEXT -> DATE (post-SQLite residue).
-- Audited high_flyer_candidates row-by-row: all non-NULL values are ISO-castable.
-- 3330 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
