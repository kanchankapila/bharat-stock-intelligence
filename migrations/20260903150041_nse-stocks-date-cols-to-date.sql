ALTER TABLE "nse_stocks"
    ALTER COLUMN "listing_date" TYPE DATE USING ("listing_date"::date);

-- 20260903150041_nse-stocks-date-cols-to-date.sql
-- AF-20260831-04: nse_stocks.listing_date TEXT -> DATE (post-SQLite residue).
-- Audited nse_stocks row-by-row: all non-NULL values are ISO-castable.
-- 2366 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
