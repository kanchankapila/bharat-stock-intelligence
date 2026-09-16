-- Up Migration
--
-- Scheduler-review report (Pipeline Day Sheet, 2026-09-04): ohlcv_quality.py's
-- ingest_corporate_actions() is one of the two 150-minute steps (the report's #4), a per-symbol
-- yfinance .splits/.dividends call across the whole universe every run. corporate_actions is an
-- EVENT table -- a symbol with no recent split/dividend has NO row in it at all -- so it cannot
-- itself answer "did we already check this symbol recently"; filter_stale_symbols() against it
-- would treat every action-free symbol (the overwhelming majority, most days) as permanently
-- stale and refetch it every run forever. Identical shape to marketsmojo_financials_fetcher.py's
-- AF-20260816-20 (migration 1787090000000) -- same fix, same table shape, mirrored here rather
-- than reinvented.

CREATE TABLE IF NOT EXISTS ohlcv_corporate_actions_checked (
  symbol     TEXT PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE ohlcv_corporate_actions_checked IS
  'Per-symbol "we already asked yfinance for splits/dividends" marker for '
  'ohlcv_quality.py''s ingest_corporate_actions(), distinct from corporate_actions itself '
  '(an event table with no row at all for a symbol with no recent action). Lets run() skip '
  'an already-checked symbol without a network round-trip. See recurring-bugs.md / AF-20260816-20 '
  '(the identical marketsmojo_financials_checked pattern) and AF-20260904-06.';

-- Down Migration
DROP TABLE IF EXISTS ohlcv_corporate_actions_checked;
