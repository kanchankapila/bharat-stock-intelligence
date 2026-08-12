-- Up Migration
-- Task 2.4: dq_check registry rows for the NSE bhavcopy pipeline. The
-- dq_check/dq_result TABLES already exist (migration 005) -- this is a data
-- migration registering what Stage 2 needs checked, per C9.8's "every new
-- table ships with a dq_check row in the same migration," generalized here
-- to "every new check CONCEPT ships in the migration that motivates it."
INSERT INTO dq_check (check_id, label, category, target_table, severity, trading_day_aware, warn_days, fail_days, spec) VALUES
  ('bhavcopy-freshness', 'Latest market_bar session is current', 'freshness', 'market_bar', 'fail', true, 1, 3, '{}'::jsonb),
  ('bhavcopy-symbol-count', 'Accepted symbols per session within a plausible band', 'coverage', 'market_bar', 'warn', true, NULL, NULL, '{"minSymbols": 1000, "maxSymbols": 3500}'::jsonb),
  ('bhavcopy-reject-rate', 'Rejected/seen ratio below threshold', 'shape', 'market_bar', 'warn', true, NULL, NULL, '{"maxRejectRate": 0.5}'::jsonb),
  ('market-bar-ohlc-sanity', 'No high<low or non-positive close in market_bar', 'plausibility', 'market_bar', 'fail', false, NULL, NULL, '{}'::jsonb),
  ('delivery-pct-range', 'delivery_pct within 0-100', 'plausibility', 'delivery_stat', 'fail', false, NULL, NULL, '{}'::jsonb),
  ('calendar-continuity', 'No gap of more than N consecutive weekdays without a session', 'coverage', 'trading_session', 'warn', false, NULL, NULL, '{"maxConsecutiveWeekdayGap": 4}'::jsonb);

-- Down Migration
DELETE FROM dq_check WHERE check_id IN (
  'bhavcopy-freshness', 'bhavcopy-symbol-count', 'bhavcopy-reject-rate',
  'market-bar-ohlc-sanity', 'delivery-pct-range', 'calendar-continuity'
);
