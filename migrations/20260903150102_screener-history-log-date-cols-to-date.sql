ALTER TABLE "screener_history_log"
    ALTER COLUMN "entry_date" TYPE DATE USING ("entry_date"::date),
    ALTER COLUMN "exit_date" TYPE DATE USING ("exit_date"::date);

-- 20260903150102_screener-history-log-date-cols-to-date.sql
-- AF-20260831-04: screener_history_log.entry_date/exit_date TEXT -> DATE (post-SQLite residue).
-- Audited screener_history_log row-by-row: all non-NULL values are ISO-castable.
-- 715992 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
