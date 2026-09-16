ALTER TABLE "signal_type_weights_history"
    ALTER COLUMN "snapshot_date" TYPE DATE USING ("snapshot_date"::date);

-- 20260903150067_signal-type-weights-history-date-cols-to-date.sql
-- AF-20260831-04: signal_type_weights_history.snapshot_date TEXT -> DATE (post-SQLite residue).
-- Audited signal_type_weights_history row-by-row: all non-NULL values are ISO-castable.
-- 19545 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
