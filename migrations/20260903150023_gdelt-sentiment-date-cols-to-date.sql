ALTER TABLE "gdelt_sentiment"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150023_gdelt-sentiment-date-cols-to-date.sql
-- AF-20260831-04: gdelt_sentiment.date TEXT -> DATE (post-SQLite residue).
-- Audited gdelt_sentiment row-by-row: all non-NULL values are ISO-castable.
-- 528 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
