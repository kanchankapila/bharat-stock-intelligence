-- Preserve unknown historical capture times. Only future inserted rows get a timestamp.
SET LOCAL lock_timeout = '5s';
ALTER TABLE nse_results_filings ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ;
ALTER TABLE nse_results_filings ALTER COLUMN first_observed_at SET DEFAULT clock_timestamp();
