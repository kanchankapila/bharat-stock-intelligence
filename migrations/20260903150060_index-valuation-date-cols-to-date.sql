ALTER TABLE "index_valuation"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150060_index-valuation-date-cols-to-date.sql
-- AF-20260831-04: index_valuation.date TEXT -> DATE (post-SQLite residue).
-- Audited index_valuation row-by-row: all non-NULL values are ISO-castable.
-- 9186 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
