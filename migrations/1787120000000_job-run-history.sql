-- Up Migration
--
-- `job_heartbeat` carries LIFETIME counters only (run_count, fail_count) plus last_status /
-- last_run_at / last_success_at. There is no run-level history for jobs anywhere in the
-- database -- checked 2026-08-22, the only job-shaped tables are job_heartbeat itself,
-- backtesting_runs, live_screener_runs and screener_runs (the last three are unrelated
-- domain tables, not scheduler history).
--
-- Consequence: a cumulative fail rate cannot be attributed to a time window, so it cannot
-- answer the one question that matters after a fix lands -- "is it still failing NOW?".
-- Live example, same day: ml-daily-ops reads 45/94 = 47.9% and trendlyne-midweek 33/42 =
-- 78.6%, but the duplicate-catch-up bug those counters largely reflect was fixed 2026-08-19
-- (registerJob.ts's alreadyPending guard not recognising the job's own ACTIVE run). Every
-- one of those failures may predate the fix and the table cannot say. Quoting the lifetime
-- number as current health is exactly the biased-slice error .claude/rules/measurement.md
-- has already retracted three times -- most directly the signal_generated_at incident, where
-- anchoring on the wrong provenance column turned a t=-3.44 into t=-1.28.
--
-- One row per run, appended by jobHeartbeat.ts's recordHeartbeat() -- the single chokepoint
-- every job already routes through, so this covers all callers rather than the handful
-- someone remembers to instrument. That is the same lesson as recurring-bugs.md's
-- "a guard test built on a hand-enumerated allowlist only guards what someone remembered to
-- list" entry.
--
-- NOT a hypertable: this is low-volume bookkeeping (~a few thousand rows/day at most),
-- and TimescaleDB compression would make the recent-window queries this exists for slower,
-- not faster. Retention is deliberately omitted for the same reason db_stats_and_retention
-- records -- dropping history is how you lose the ability to answer "when did this start".

CREATE TABLE IF NOT EXISTS job_run_history (
  id         BIGSERIAL   PRIMARY KEY,
  job_name   TEXT        NOT NULL,
  status     TEXT        NOT NULL,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  error      TEXT
);

-- The access pattern this table exists for: "how has <job> done over the last N days".
-- Deliberately NOT schema-qualified as `public.` -- db/schema.postgres.sql qualifies its index
-- DDL but not its CREATE TABLEs, and applying that file into a throwaway schema therefore
-- creates the table where asked and then indexes the PRODUCTION one (recurring-bugs.md, hit
-- 2026-08-16 building the vitest schema). Keeping both statements unqualified means they
-- always agree on wherever search_path points.
CREATE INDEX IF NOT EXISTS idx_job_run_history_name_ran
  ON job_run_history (job_name, ran_at DESC);

COMMENT ON TABLE job_run_history IS
  'One row per job run, appended by jobHeartbeat.ts recordHeartbeat(). Added 2026-08-22 '
  'because job_heartbeat carries only lifetime counters, so no windowed fail rate -- and '
  'therefore no "did the fix work" -- could be computed. Rows start at the migration date; '
  'deliberately not backfilled, since per-run history for past runs was never captured and '
  'reconstructing it would fabricate evidence.';

-- Down Migration
DROP TABLE IF EXISTS job_run_history;
