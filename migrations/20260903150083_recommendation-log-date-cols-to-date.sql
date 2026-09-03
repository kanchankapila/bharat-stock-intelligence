ALTER TABLE "recommendation_log"
    ALTER COLUMN "signal_date" TYPE DATE USING ("signal_date"::date);

-- 20260903150083_recommendation-log-date-cols-to-date.sql
-- AF-20260831-04: recommendation_log.signal_date TEXT -> DATE (post-SQLite residue).
-- Audited recommendation_log row-by-row: all non-NULL values are ISO-castable.
-- 51249 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
