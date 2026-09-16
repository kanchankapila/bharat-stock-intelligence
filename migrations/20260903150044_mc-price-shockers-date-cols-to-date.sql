ALTER TABLE "mc_price_shockers"
    ALTER COLUMN "result_date" TYPE DATE USING ("result_date"::date);

-- 20260903150044_mc-price-shockers-date-cols-to-date.sql
-- AF-20260831-04: mc_price_shockers.result_date TEXT -> DATE (post-SQLite residue).
-- Audited mc_price_shockers row-by-row: all non-NULL values are ISO-castable.
-- 2779 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
