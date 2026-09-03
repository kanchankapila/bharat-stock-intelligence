ALTER TABLE "mc_chart_patterns"
    ALTER COLUMN "end_date" TYPE DATE USING ("end_date"::date);

-- 20260903150028_mc-chart-patterns-date-cols-to-date.sql
-- AF-20260831-04: mc_chart_patterns.end_date TEXT -> DATE (post-SQLite residue).
-- Audited mc_chart_patterns row-by-row: all non-NULL values are ISO-castable.
-- 819 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
