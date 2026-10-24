-- The ROC read needs four narrow columns from a very wide, frequently enriched daily table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE INDEX idx_ts_roc_diagnostics
  ON technical_signals(date, symbol) INCLUDE (nifty_regime, win_probability)
  WHERE win_probability IS NOT NULL;
