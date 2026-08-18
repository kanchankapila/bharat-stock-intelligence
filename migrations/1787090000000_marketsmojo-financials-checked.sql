-- Up Migration
--
-- AF-20260816-20: marketsmojo_financials_fetcher.py's run() fetches every symbol's full HTTP
-- response before it can even look at load_known_values() -- there is no way to know whether a
-- cell changed without the response, so "check first, fetch only if stale" is impossible using
-- marketsmojo_financials_history alone (it's a per-CELL table, PK'd on symbol/statement/
-- period_label/line_item with no per-symbol date column -- see load_known_values()'s own
-- docstring). Its fetched_at only advances when a cell's VALUE actually changes, so it can't be
-- used as a "did we already check this symbol recently" signal either -- a symbol with genuinely
-- stable financials would look permanently stale and get refetched every single run forever.
--
-- This is the missing signal: a per-symbol "we already asked" marker, independent of whether
-- anything changed. run() upserts a row here after every attempt (success or empty response --
-- both mean "asked, got an answer") and skips symbols checked within the fetcher's own staleness
-- window before spending an HTTP round-trip on them. A missing-mapping skip does no network call
-- already, so it doesn't need this table.

CREATE TABLE IF NOT EXISTS marketsmojo_financials_checked (
  symbol     TEXT PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE marketsmojo_financials_checked IS
  'Per-symbol "we already asked marketsmojo" marker for marketsmojo_financials_fetcher.py, '
  'distinct from marketsmojo_financials_history.fetched_at (which only advances on a genuine '
  'value change). Lets run() skip an already-checked symbol without an HTTP round-trip. '
  'See recurring-bugs.md / AF-20260816-20.';

-- Down Migration
DROP TABLE IF EXISTS marketsmojo_financials_checked;
