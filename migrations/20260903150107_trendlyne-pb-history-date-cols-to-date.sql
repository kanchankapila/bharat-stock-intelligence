ALTER TABLE "trendlyne_pb_history"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150107_trendlyne-pb-history-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_pb_history.date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_pb_history row-by-row: all non-NULL values are ISO-castable.
-- 4195898 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
