ALTER TABLE "macro_indicators"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150064_macro-indicators-date-cols-to-date.sql
-- AF-20260831-04: macro_indicators.date TEXT -> DATE (post-SQLite residue).
-- Audited macro_indicators row-by-row: all non-NULL values are ISO-castable.
-- 9614 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
