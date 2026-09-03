ALTER TABLE "signal_outcomes"
    ALTER COLUMN "check_date" TYPE DATE USING ("check_date"::date),
    ALTER COLUMN "signal_date" TYPE DATE USING ("signal_date"::date);

-- 20260903150103_signal-outcomes-date-cols-to-date.sql
-- AF-20260831-04: signal_outcomes.check_date/signal_date TEXT -> DATE (post-SQLite residue).
-- Audited signal_outcomes row-by-row: all non-NULL values are ISO-castable.
-- 819016 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
