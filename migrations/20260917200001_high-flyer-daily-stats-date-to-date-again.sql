ALTER TABLE "high_flyer_daily_stats"
    ALTER COLUMN "date" TYPE DATE USING ("date"::date);

-- 20260917200001_high-flyer-daily-stats-date-to-date-again.sql
-- AF-20260917-19, second half. Same cause as 20260917200000 (see that file's note): the table
-- was dropped from live by a test, recreated from stale in-code DDL declaring `date TEXT`, and
-- so lost the type 20260903150002 had already given it.
--
-- Kept as its own file on purpose: node-pg-migrate's .sql runner has silently executed only a
-- file's FIRST statement in this repo before (measurement.md, technical_signals.date TEXT->DATE),
-- so one statement per migration is the shape that is known to actually apply here.
