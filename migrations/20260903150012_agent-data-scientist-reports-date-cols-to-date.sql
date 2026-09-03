ALTER TABLE "agent_data_scientist_reports"
    ALTER COLUMN "run_date" TYPE DATE USING ("run_date"::date);

-- 20260903150012_agent-data-scientist-reports-date-cols-to-date.sql
-- AF-20260831-04: agent_data_scientist_reports.run_date TEXT -> DATE (post-SQLite residue).
-- Audited agent_data_scientist_reports row-by-row: all non-NULL values are ISO-castable.
-- 93 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
