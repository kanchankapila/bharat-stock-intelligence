ALTER TABLE "engine_composite_scores"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150088_engine-composite-scores-date-cols-to-date.sql
-- AF-20260831-04: engine_composite_scores.date TEXT -> DATE (post-SQLite residue).
-- Audited engine_composite_scores row-by-row: all non-NULL values are ISO-castable.
-- 93460 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
