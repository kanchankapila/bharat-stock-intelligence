-- Up Migration
-- Task 5.3's own Verify requirement / two more of Task 5.6's four Stage 5 dq
-- checks. `promotion-not-premature` (migration 011) is the third; the fourth
-- (`shadow-recommendation-freshness`) is deferred -- not required by Task
-- 5.3 or Task 5.4's own Verify text, unlike these two.
INSERT INTO dq_check (check_id, label, category, target_table, severity, trading_day_aware, warn_days, fail_days, spec) VALUES
  ('shadow-rank-variance', 'The shadow ranker''s latest session has a non-degenerate score distribution (not a collapsed universe or an identical score for every symbol)', 'plausibility', 'recommendation', 'fail', true, NULL, NULL, '{"minSymbols": 5, "varianceFloor": 1e-6}'::jsonb),
  ('dual-run-divergence-sane', 'Task 5.3''s divergence monitor is actually computing rank_correlation/directional_agreement (not stale, not perpetually NULL)', 'plausibility', 'recommendation', 'warn', true, NULL, NULL, '{}'::jsonb);

-- Down Migration
DELETE FROM dq_check WHERE check_id IN ('shadow-rank-variance', 'dual-run-divergence-sane');
