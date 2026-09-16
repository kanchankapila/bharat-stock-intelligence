ALTER TABLE "mc_pricefeed_daily"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date),
    ALTER COLUMN "high_52w_date" TYPE DATE USING (NULLIF("high_52w_date", '')::date),
    ALTER COLUMN "low_52w_date" TYPE DATE USING (NULLIF("low_52w_date", '')::date);

-- 20260903150090_mc-pricefeed-daily-date-cols-to-date.sql
-- AF-20260831-04: mc_pricefeed_daily.date/high_52w_date/low_52w_date TEXT -> DATE (post-SQLite residue).
-- Audited mc_pricefeed_daily row-by-row: all non-NULL values are ISO-castable except empty-string placeholders, NULLIF'd to NULL.
-- 102676 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
