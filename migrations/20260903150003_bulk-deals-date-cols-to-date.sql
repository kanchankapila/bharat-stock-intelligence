ALTER TABLE "bulk_deals"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150003_bulk-deals-date-cols-to-date.sql
-- AF-20260831-04: bulk_deals.date TEXT -> DATE (post-SQLite residue).
-- Audited bulk_deals row-by-row: all non-NULL values are ISO-castable.
-- 8 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
