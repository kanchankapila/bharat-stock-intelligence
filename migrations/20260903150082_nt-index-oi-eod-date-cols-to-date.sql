ALTER TABLE "nt_index_oi_eod"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150082_nt-index-oi-eod-date-cols-to-date.sql
-- AF-20260831-04: nt_index_oi_eod.date TEXT -> DATE (post-SQLite residue).
-- Audited nt_index_oi_eod row-by-row: all non-NULL values are ISO-castable.
-- 48201 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
