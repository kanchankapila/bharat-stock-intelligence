-- Up Migration
--
-- signal_outcomes had no way to tell which upstream signal a row grades. outcome_resolver.py
-- (technical_signals, horizons 1/5/15) and confluence_outcome_tracker.py (confluence_signals,
-- horizons 3/7/14/30) were both writing the same (symbol, signal_date, horizon_days) key --
-- each guarding only against re-writing a combo that already has ANY row, regardless of source
-- -- so they silently avoided colliding by accident (whichever ran first for a given horizon
-- "won" it permanently) rather than by design. ML consumers that JOIN signal_outcomes back to
-- technical_signals on (symbol, date) implicitly assumed every matched row graded that day's
-- technical signal -- false for h3/7/14/30, which are confluence-sourced. unified_signal_outcomes
-- (the sibling outcome table) already has this exact signal_source discriminator; this mirrors it.
--
-- Existing rows get signal_source='unknown' here (267,976 rows at time of writing) --
-- backfilled separately (inferred from label_definition: path_barrier->technical,
-- terminal_pct2->confluence) as its own reviewable step, not part of this schema change.
ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS signal_source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE signal_outcomes DROP CONSTRAINT IF EXISTS signal_outcomes_pkey;
ALTER TABLE signal_outcomes ADD PRIMARY KEY (symbol, signal_date, horizon_days, signal_source);
CREATE INDEX IF NOT EXISTS idx_sout_source ON signal_outcomes(signal_source);

-- Down Migration
DROP INDEX IF EXISTS idx_sout_source;
ALTER TABLE signal_outcomes DROP CONSTRAINT IF EXISTS signal_outcomes_pkey;
ALTER TABLE signal_outcomes ADD PRIMARY KEY (symbol, signal_date, horizon_days);
ALTER TABLE signal_outcomes DROP COLUMN IF EXISTS signal_source;
