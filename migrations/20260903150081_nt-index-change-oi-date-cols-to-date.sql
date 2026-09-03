ALTER TABLE "nt_index_change_oi"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150081_nt-index-change-oi-date-cols-to-date.sql
-- AF-20260831-04: nt_index_change_oi.date TEXT -> DATE (post-SQLite residue).
-- Audited nt_index_change_oi row-by-row: all non-NULL values are ISO-castable.
-- 48199 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
