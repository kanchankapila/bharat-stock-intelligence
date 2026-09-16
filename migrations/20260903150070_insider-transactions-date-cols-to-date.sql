ALTER TABLE "insider_transactions"
    ALTER COLUMN "transaction_date" TYPE DATE USING ("transaction_date"::date);

-- 20260903150070_insider-transactions-date-cols-to-date.sql
-- AF-20260831-04: insider_transactions.transaction_date TEXT -> DATE (post-SQLite residue).
-- Audited insider_transactions row-by-row: all non-NULL values are ISO-castable.
-- 23596 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
