ALTER TABLE "sector_correlation_pairs"
    ALTER COLUMN "data_date" TYPE DATE USING ("data_date"::date);

-- 20260903150050_sector-correlation-pairs-date-cols-to-date.sql
-- AF-20260831-04: sector_correlation_pairs.data_date TEXT -> DATE (post-SQLite residue).
-- Audited sector_correlation_pairs row-by-row: all non-NULL values are ISO-castable.
-- 3990 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
