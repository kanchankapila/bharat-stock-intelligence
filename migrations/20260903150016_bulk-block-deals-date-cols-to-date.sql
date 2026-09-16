ALTER TABLE "bulk_block_deals"
    ALTER COLUMN "deal_date" TYPE DATE USING ("deal_date"::date);

-- 20260903150016_bulk-block-deals-date-cols-to-date.sql
-- AF-20260831-04: bulk_block_deals.deal_date TEXT -> DATE (post-SQLite residue).
-- Audited bulk_block_deals row-by-row: all non-NULL values are ISO-castable.
-- 275 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
