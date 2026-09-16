ALTER TABLE "sector_global_corr"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150017_sector-global-corr-date-cols-to-date.sql
-- AF-20260831-04: sector_global_corr.date TEXT -> DATE (post-SQLite residue).
-- Audited sector_global_corr row-by-row: all non-NULL values are ISO-castable.
-- 305 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
