ALTER TABLE "agent_strategy_picks"
    ALTER COLUMN "run_date" TYPE DATE USING ("run_date"::date);

-- 20260903150030_agent-strategy-picks-date-cols-to-date.sql
-- AF-20260831-04: agent_strategy_picks.run_date TEXT -> DATE (post-SQLite residue).
-- Audited agent_strategy_picks row-by-row: all non-NULL values are ISO-castable.
-- 876 rows at migration time. Writers use ISO literals/params, which cast
-- implicitly to DATE, so this is a drop-in type change -- no application code changes.
