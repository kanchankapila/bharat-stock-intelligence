ALTER TABLE "so_option_chain"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150100_so-option-chain-date-cols-to-date.sql
-- AF-20260831-04: so_option_chain.date TEXT -> DATE (post-SQLite residue).
-- Audited so_option_chain row-by-row: all non-NULL values are ISO-castable.
-- 568957 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
