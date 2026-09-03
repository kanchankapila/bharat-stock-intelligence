ALTER TABLE "historical_fno_sentiment"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150022_historical-fno-sentiment-date-cols-to-date.sql
-- AF-20260831-04: historical_fno_sentiment.date TEXT -> DATE (post-SQLite residue).
-- Audited historical_fno_sentiment row-by-row: all non-NULL values are ISO-castable.
-- 523 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
