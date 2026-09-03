ALTER TABLE "investsights_pe_band_history"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150096_investsights-pe-band-history-date-cols-to-date.sql
-- AF-20260831-04: investsights_pe_band_history.date TEXT -> DATE (post-SQLite residue).
-- Audited investsights_pe_band_history row-by-row: all non-NULL values are ISO-castable.
-- 314704 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
