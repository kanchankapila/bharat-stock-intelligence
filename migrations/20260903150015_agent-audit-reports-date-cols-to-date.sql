ALTER TABLE "agent_audit_reports"
    ALTER COLUMN "audit_for_date" TYPE DATE USING ("audit_for_date"::date),
    ALTER COLUMN "run_date" TYPE DATE USING ("run_date"::date);

-- 20260903150015_agent-audit-reports-date-cols-to-date.sql
-- AF-20260831-04: agent_audit_reports.audit_for_date/run_date TEXT -> DATE (post-SQLite residue).
-- Audited agent_audit_reports row-by-row: all non-NULL values are ISO-castable.
-- 229 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
