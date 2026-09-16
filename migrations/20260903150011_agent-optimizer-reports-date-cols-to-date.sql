ALTER TABLE "agent_optimizer_reports"
    ALTER COLUMN "run_date" TYPE DATE USING ("run_date"::date);

-- 20260903150011_agent-optimizer-reports-date-cols-to-date.sql
-- AF-20260831-04: agent_optimizer_reports.run_date TEXT -> DATE (post-SQLite residue).
-- Audited agent_optimizer_reports row-by-row: all non-NULL values are ISO-castable.
-- 86 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
