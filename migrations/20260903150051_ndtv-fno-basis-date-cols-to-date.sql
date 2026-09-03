ALTER TABLE "ndtv_fno_basis"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150051_ndtv-fno-basis-date-cols-to-date.sql
-- AF-20260831-04: ndtv_fno_basis.date TEXT -> DATE (post-SQLite residue).
-- Audited ndtv_fno_basis row-by-row: all non-NULL values are ISO-castable.
-- 4113 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
