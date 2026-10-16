-- Winner-only precursor lift confuses volatility with bullish direction. Persist the
-- mirrored loser-tail counts so the daily learner can require winner-vs-loser separation.
SET lock_timeout = '10s';

ALTER TABLE high_flyer_daily_stats
  ADD COLUMN IF NOT EXISTS diver_n INTEGER,
  ADD COLUMN IF NOT EXISTS diver_precursor_counts_json TEXT;
