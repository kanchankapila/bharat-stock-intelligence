ALTER TABLE "signal_excursions"
    ALTER COLUMN "signal_date" TYPE DATE USING ("signal_date"::date);

-- 20260903150098_signal-excursions-date-cols-to-date.sql
-- AF-20260831-04: signal_excursions.signal_date TEXT -> DATE (post-SQLite residue).
-- Audited signal_excursions row-by-row: all non-NULL values are ISO-castable.
-- 395273 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
