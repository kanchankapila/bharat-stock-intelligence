ALTER TABLE "trendlyne_price_analysis"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150075_trendlyne-price-analysis-date-cols-to-date.sql
-- AF-20260831-04: trendlyne_price_analysis.date TEXT -> DATE (post-SQLite residue).
-- Audited trendlyne_price_analysis row-by-row: all non-NULL values are ISO-castable.
-- 31849 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
