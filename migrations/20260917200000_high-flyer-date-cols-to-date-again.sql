ALTER TABLE "high_flyer_retrospective"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260917200000_high-flyer-date-cols-to-date-again.sql
-- AF-20260917-19. This re-applies 20260903150000, and the reason it has to is the finding.
--
-- high_flyer_retrospective and high_flyer_daily_stats were DROPPED from live Postgres by
-- src/server/__tests__/signalAccuracyDigest.test.ts's `DROP TABLE IF EXISTS` running against
-- production, and were recreated on 2026-09-17 by high_flyer_retrospective.py's own
-- `CREATE TABLE IF NOT EXISTS`. That DDL body still declares `date TEXT` -- it predates the
-- 2026-09-03 TEXT->DATE migrations and was never updated, because CREATE TABLE IF NOT EXISTS
-- is a no-op on an existing table so nobody ever saw it run again.
--
-- So a migration's ledger row is not proof the column is still that type: drop and recreate the
-- table from stale in-code DDL and the type silently reverts, while `pgmigrations` keeps saying
-- the conversion ran. The script's own CREATE TABLE bodies are corrected in the same commit so
-- a fresh database gets DATE directly and this cannot recur.
--
-- Both tables were empty of pre-existing rows at the time of this change (the retrospective had
-- just repopulated 2026-09-17 only), and every value is an ISO literal, so the cast is exact.
