ALTER TABLE "job_run_history"
    ADD COLUMN IF NOT EXISTS "duration_ms" BIGINT;

-- 20260904120000_job-run-history-add-duration.sql
-- Scheduler-review finding (Pipeline Day Sheet, 2026-09-04): job_run_history stores status
-- and ran_at but no duration, so nothing in this platform can answer "which of the 183
-- runPython()/T.run() steps got slower this month" without a hand-run stopwatch. Nullable,
-- additive -- existing rows read back NULL, new rows populate it where the caller has a
-- start time (StepTracker's per-step ms first; queues.ts's ~30 standalone recordHeartbeat()
-- call sites are a follow-up, not covered by this pass).
