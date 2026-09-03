ALTER TABLE "daily_research_reports"
    ALTER COLUMN "report_date" TYPE DATE USING ("report_date"::date);

-- 20260903150014_daily-research-reports-date-cols-to-date.sql
-- AF-20260831-04: daily_research_reports.report_date TEXT -> DATE (post-SQLite residue).
-- Audited daily_research_reports row-by-row: all non-NULL values are ISO-castable.
-- 109 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
