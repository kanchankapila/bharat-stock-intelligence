-- Up Migration
--
-- Storage for the /trade-desk skill's trade journal (src/server/trade_journal.py), moved out of
-- the JSONL file it shipped with on 2026-08-13. The JSONL path is NOT removed -- it stays as an
-- offline fallback so a trade can still be logged from a laptop with no tunnel to :5433, and
-- syncs into this table on the next connect (`trade_journal.py sync`). `synced_at` is what makes
-- that reconciliation idempotent.
--
-- This is USER-ENTERED state, not a datasource and not a signal table.
--   * It is deliberately NOT a fifth signal table (scoring-authority.md caps that at four). It
--     grades the user's own fills, never the platform's signals -- unified_signal_outcomes and
--     signal_outcomes remain the only things that grade what the platform emitted.
--   * It gets NO entry in TABLE_FRESHNESS_CHECKS. data-sources.md's freshness mandate covers
--     fetchers writing from an external API; a table that is only ever written when a human
--     places a trade is stale by design on any day they didn't trade, and a check firing every
--     quiet week is the "cries wolf on real data" failure that stops checks being read at all.
--
-- PK is the writer-issued `id` (a uuid4 hex), not (symbol, trade_date): scaling into the same
-- name on the same session is a legitimate second row, and a natural key would silently collapse
-- the two. Nothing here is provider-issued, so the composite-key rule in data-sources.md does not
-- apply -- but note `setup` is the same shape of trap as `signal_source` was, so it is written
-- lowercase by the one writer and compared lowercase; do not add a second writer with its own
-- casing (recurring-bugs.md's screener_catalog / signal_source case-collision entries).
--
-- Grading columns are filled by `trade_journal.py grade` from settled stock_ohlcv, and are all
-- NULLABLE on purpose: a trade logged at entry has no exit yet, and an ungraded row must be
-- distinguishable from a genuinely flat one. `float(x or 0)` on any of these would fabricate a
-- 0.00% result -- the exact NaN-coercion class in recurring-bugs.md.

CREATE TABLE IF NOT EXISTS trade_journal (
  id                TEXT PRIMARY KEY,
  -- Lowercase slug of the setup traded, e.g. 'capitulation_triple'. Compared lowercase.
  setup             TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  -- Session the setup FIRED. The measured tier-1 result is signal-on-D, trade-on-D+1, so these
  -- are two different dates and conflating them destroys the edge (measurement.md).
  signal_date       TEXT,
  -- Session the trade was entered and exited. The grader keys on this.
  trade_date        TEXT NOT NULL,
  side              TEXT NOT NULL DEFAULT 'LONG',
  qty               DOUBLE PRECISION,
  -- The user's ACTUAL fills.
  entry_price       DOUBLE PRECISION,
  exit_price        DOUBLE PRECISION,
  notes             TEXT,
  logged_at         TIMESTAMPTZ,

  -- ── filled by `grade`, from settled OHLCV ────────────────────────────────────────────────
  -- What the backtest would have got: stock_ohlcv open/close on trade_date.
  model_open        DOUBLE PRECISION,
  model_close       DOUBLE PRECISION,
  -- Winsorized mean open->close of the liquid universe that date -- the benchmark subtracted
  -- from both excess figures below, matching screener_combo_finder._day_level_backtest.
  universe_ret      DOUBLE PRECISION,
  model_excess_pct  DOUBLE PRECISION,
  real_excess_pct   DOUBLE PRECISION,
  -- model minus real. The decision-relevant number: the tier-1 setup pays +0.53%/day, so a drag
  -- larger than that means the fills are the problem, not the signal.
  slippage_pct      DOUBLE PRECISION,

  -- NULL for a row that has only ever lived in the offline JSONL file; stamped when the sync
  -- reconciles it into this table. Never part of an ON CONFLICT update list -- that is what
  -- turned unified_signals.signal_generated_at from a generation time into a last-seen time
  -- (migration 1786920000000).
  synced_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- `grade` selects ungraded rows and groups them by date; `report` sweeps a date range.
CREATE INDEX IF NOT EXISTS idx_trade_journal_trade_date ON trade_journal (trade_date);
CREATE INDEX IF NOT EXISTS idx_trade_journal_setup_date ON trade_journal (setup, trade_date);

-- Down Migration
DROP TABLE IF EXISTS trade_journal;
