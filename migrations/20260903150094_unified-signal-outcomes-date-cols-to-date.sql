ALTER TABLE "unified_signal_outcomes"
    ALTER COLUMN "check_date" TYPE DATE USING ("check_date"::date),
    ALTER COLUMN "signal_date" TYPE DATE USING ("signal_date"::date);

-- 20260903150094_unified-signal-outcomes-date-cols-to-date.sql
-- AF-20260831-04: unified_signal_outcomes.check_date/signal_date TEXT -> DATE (post-SQLite residue).
-- Audited unified_signal_outcomes row-by-row: all non-NULL values are ISO-castable.
-- 253792 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
