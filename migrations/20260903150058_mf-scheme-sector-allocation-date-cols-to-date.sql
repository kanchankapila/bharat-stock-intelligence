ALTER TABLE "mf_scheme_sector_allocation"
    ALTER COLUMN "holding_date" TYPE DATE USING ("holding_date"::date);

-- 20260903150058_mf-scheme-sector-allocation-date-cols-to-date.sql
-- AF-20260831-04: mf_scheme_sector_allocation.holding_date TEXT -> DATE (post-SQLite residue).
-- Audited mf_scheme_sector_allocation row-by-row: all non-NULL values are ISO-castable.
-- 8272 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
