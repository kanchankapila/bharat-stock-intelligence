ALTER TABLE "index_max_pain"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150024_index-max-pain-date-cols-to-date.sql
-- AF-20260831-04: index_max_pain.date TEXT -> DATE (post-SQLite residue).
-- Audited index_max_pain row-by-row: all non-NULL values are ISO-castable.
-- 534 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
