ALTER TABLE "ohlcv_adjustment_factors"
    ALTER COLUMN "ex_date" TYPE DATE USING ("ex_date"::date);

-- 20260903150043_ohlcv-adjustment-factors-date-cols-to-date.sql
-- AF-20260831-04: ohlcv_adjustment_factors.ex_date TEXT -> DATE (post-SQLite residue).
-- Audited ohlcv_adjustment_factors row-by-row: all non-NULL values are ISO-castable.
-- 2723 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
