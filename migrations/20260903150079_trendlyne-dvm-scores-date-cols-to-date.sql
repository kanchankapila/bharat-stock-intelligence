ALTER TABLE "trendlyne_dvm_scores"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150079_trendlyne-dvm-scores-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_dvm_scores.date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_dvm_scores row-by-row: all non-NULL values are ISO-castable.
-- 41557 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
