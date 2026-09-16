ALTER TABLE "block_deals"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150055_block-deals-date-cols-to-date.sql
-- AF-20260831-04: block_deals.date TEXT -> DATE (post-SQLite residue).
-- Audited block_deals row-by-row: all non-NULL values are ISO-castable.
-- 6801 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
