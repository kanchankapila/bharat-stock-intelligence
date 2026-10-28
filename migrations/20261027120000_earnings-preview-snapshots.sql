-- Append-only log of what earnings_preview.py forecast for each upcoming reporter, as of the close it was made.
-- Research only: never read by the ranker. First write per (as_of_date, symbol, period, version) wins.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE earnings_preview_snapshots (
  as_of_date DATE NOT NULL,
  symbol TEXT NOT NULL,
  period_end DATE NOT NULL,
  model_version TEXT NOT NULL,
  expected_date DATE,
  score DOUBLE PRECISION,
  score_eq DOUBLE PRECISION,
  score_learned DOUBLE PRECISION,
  score_pct DOUBLE PRECISION,
  decile INTEGER,
  n_features INTEGER NOT NULL,
  features JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (as_of_date, symbol, period_end, model_version)
);
CREATE INDEX idx_earnings_preview_snapshots_period ON earnings_preview_snapshots(period_end, model_version, symbol);
