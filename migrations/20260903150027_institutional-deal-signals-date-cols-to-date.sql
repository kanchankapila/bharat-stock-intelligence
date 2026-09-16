ALTER TABLE "institutional_deal_signals"
    ALTER COLUMN "deal_date" TYPE DATE USING ("deal_date"::date);

-- 20260903150027_institutional-deal-signals-date-cols-to-date.sql
-- AF-20260831-04: institutional_deal_signals.deal_date TEXT -> DATE (post-SQLite residue).
-- Audited institutional_deal_signals row-by-row: all non-NULL values are ISO-castable.
-- 708 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
