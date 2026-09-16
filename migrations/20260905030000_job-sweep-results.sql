-- Up Migration
--
-- One-job-at-a-time validation sweep (2026-09-05). The platform's ~60 BullMQ queues had never
-- been individually timed or verified to actually WRITE anything: job_run_history records
-- status and (only since 20260904120000) duration_ms, but a job that succeeds while writing
-- zero rows is indistinguishable there from a healthy one -- the exact "skip-path stamped as
-- success" / "success heartbeat on a step that wrote nothing" class in recurring-bugs.md.
--
-- tables_written is derived EMPIRICALLY by diffing pg_stat_user_tables (n_tup_ins/upd/del)
-- either side of the run, not from a hand-maintained job->table map. That choice is deliberate:
-- recurring-bugs.md's "a guard built on a hand-enumerated allowlist only guards what someone
-- remembered to list" applies directly -- a static map would silently miss any table a job
-- newly starts (or stops) writing, which is precisely the failure this sweep exists to catch.
--
-- stderr_class exists because pythonRunner.ts currently labels ANY non-empty stderr as
-- "finished successfully with warnings", and the dominant real-world cases are a transformers
-- efficiency hint and scrapy's own INFO lines -- i.e. most "warnings" in the logs are not
-- warnings at all. Recording the classification per run lets the noise floor be measured
-- instead of argued about.

CREATE TABLE IF NOT EXISTS job_sweep_results (
  id             BIGSERIAL PRIMARY KEY,
  sweep_id       TEXT        NOT NULL,
  job_name       TEXT        NOT NULL,
  lane           TEXT,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  duration_ms    BIGINT,
  status         TEXT        NOT NULL,
  stderr_class   TEXT,
  error          TEXT,
  tables_written JSONB,
  row_delta      BIGINT,
  notes          TEXT,
  UNIQUE (sweep_id, job_name)
);

CREATE INDEX IF NOT EXISTS idx_job_sweep_results_sweep ON job_sweep_results (sweep_id, started_at DESC);

COMMENT ON TABLE job_sweep_results IS
  'Per-job results of the controlled one-at-a-time validation sweep: wall-clock duration, '
  'terminal status, and the tables the run actually wrote. Distinct from job_run_history '
  '(which records scheduled production runs) -- this records deliberate, isolated sweep runs '
  'made with SCHEDULER_PAUSED=1. See docs/audit-findings.md and the 2026-09-05 session log.';

COMMENT ON COLUMN job_sweep_results.tables_written IS
  'Empirical pg_stat_user_tables diff for the run: {"table": {"ins": n, "upd": n, "del": n}}. '
  'Hypertable _hyper_N_M_chunk relations are rolled up to their parent hypertable. An empty '
  'object on a job that reports success is the finding, not a gap in this column.';

COMMENT ON COLUMN job_sweep_results.stderr_class IS
  'clean | benign_warning | real_error. Benign covers library chatter that pythonRunner.ts '
  'currently mislabels as a warning (transformers GPU hints, scrapy INFO lines).';

-- Down Migration
DROP TABLE IF EXISTS job_sweep_results;
