-- Up Migration
-- Task 5.6's fourth and final Stage 5 DQ check. The check logic itself lives
-- in stage5/dq-checks.ts (checkShadowRecommendationFreshness); the row here
-- registers it in the dq_check catalog so dq_result rows reference a known
-- check_id. warn_days/fail_days are NULL because the threshold (1 session →
-- warn, 2+ sessions → fail) is expressed in trading-session counts queried
-- from the trading_session table, not in calendar days.
INSERT INTO dq_check (check_id, label, category, target_table, severity, trading_day_aware, warn_days, fail_days, spec) VALUES
  ('shadow-recommendation-freshness', 'The shadow ranker wrote a recommendation row for the most recent trading session (gf-ranker-daily is running)', 'freshness', 'recommendation', 'fail', true, NULL, NULL, '{}'::jsonb);

-- Down Migration
DELETE FROM dq_check WHERE check_id = 'shadow-recommendation-freshness';
