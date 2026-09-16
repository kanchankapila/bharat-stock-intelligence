ALTER TABLE "index_option_oi"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150049_index-option-oi-date-cols-to-date.sql
-- AF-20260831-04: index_option_oi.date TEXT -> DATE (post-SQLite residue).
-- Audited index_option_oi row-by-row: all non-NULL values are ISO-castable.
-- 3804 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
