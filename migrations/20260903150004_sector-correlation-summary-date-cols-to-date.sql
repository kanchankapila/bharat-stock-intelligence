ALTER TABLE "sector_correlation_summary"
    ALTER COLUMN "data_date" TYPE DATE USING ("data_date"::date);

-- 20260903150004_sector-correlation-summary-date-cols-to-date.sql
-- AF-20260831-04: sector_correlation_summary.data_date TEXT -> DATE (post-SQLite residue).
-- Audited sector_correlation_summary row-by-row: all non-NULL values are ISO-castable.
-- 21 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
