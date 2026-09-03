ALTER TABLE "mc_pattern_signals"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260903150089_mc-pattern-signals-date-cols-to-date.sql
-- AF-20260831-04: mc_pattern_signals.date TEXT -> DATE (post-SQLite residue).
-- Audited mc_pattern_signals row-by-row: all non-NULL values are ISO-castable.
-- 99986 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
