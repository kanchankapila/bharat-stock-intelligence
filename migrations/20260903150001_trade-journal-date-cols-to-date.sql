ALTER TABLE "trade_journal"
    ALTER COLUMN "signal_date" TYPE DATE USING ("signal_date"::date),
    ALTER COLUMN "trade_date" TYPE DATE USING ("trade_date"::date);

-- 20260903150001_trade-journal-date-cols-to-date.sql
-- AF-20260831-04: trade_journal.signal_date/trade_date TEXT -> DATE (post-SQLite residue).
-- Audited trade_journal row-by-row: all non-NULL values are ISO-castable.
-- 0 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
