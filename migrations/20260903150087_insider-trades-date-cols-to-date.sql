ALTER TABLE "insider_trades"
    ALTER COLUMN "date_iso" TYPE DATE USING ("date_iso"::date);

-- 20260903150087_insider-trades-date-cols-to-date.sql
-- AF-20260831-04: insider_trades.date_iso TEXT -> DATE (post-SQLite residue).
-- Audited insider_trades row-by-row: all non-NULL values are ISO-castable.
-- 72125 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
