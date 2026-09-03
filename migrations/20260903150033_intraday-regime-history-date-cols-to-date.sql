ALTER TABLE "intraday_regime_history"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150033_intraday-regime-history-date-cols-to-date.sql
-- AF-20260831-04: intraday_regime_history.date TEXT -> DATE (post-SQLite residue).
-- Audited intraday_regime_history row-by-row: all non-NULL values are ISO-castable.
-- 933 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
