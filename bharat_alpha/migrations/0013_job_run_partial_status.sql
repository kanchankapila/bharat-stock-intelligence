-- A multi-source step can complete its critical path while one optional connector fails.
-- Calling that parent run "success" hides the child failure; calling it "failed" stops the
-- independent scoring/publishing path. `partial` is therefore a first-class honest state.
ALTER TABLE alpha.job_run DROP CONSTRAINT IF EXISTS job_run_status_check;
ALTER TABLE alpha.job_run
    ADD CONSTRAINT job_run_status_check
    CHECK (status IN ('running', 'success', 'partial', 'skipped', 'failed'));
