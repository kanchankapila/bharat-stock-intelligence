ALTER TABLE "tl_financial_quality"
    ALTER COLUMN "as_of_date" TYPE DATE USING ("as_of_date"::date);

-- 20260903150066_tl-financial-quality-date-cols-to-date.sql
-- AF-20260831-04: tl_financial_quality.as_of_date TEXT -> DATE (post-SQLite residue).
-- Audited tl_financial_quality row-by-row: all non-NULL values are ISO-castable.
-- 13793 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
