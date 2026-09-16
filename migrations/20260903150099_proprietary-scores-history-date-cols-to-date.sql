ALTER TABLE "proprietary_scores_history"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150099_proprietary-scores-history-date-cols-to-date.sql
-- AF-20260831-04: proprietary_scores_history.date TEXT -> DATE (post-SQLite residue).
-- Audited proprietary_scores_history row-by-row: all non-NULL values are ISO-castable.
-- 536363 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
