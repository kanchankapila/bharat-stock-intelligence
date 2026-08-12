-- Up Migration
--
-- Six orphaned columns on technical_signals: no writer, no reader, no DDL in db.ts. They exist
-- only in the live database, left behind by an ALTER that was removed from the schema-of-record
-- at some point without a corresponding DROP.
--
-- Verified 2026-08-13 before dropping:
--   * 0 references across src/**/*.{py,ts,tsx,sql} and migrations/ for all six names
--   * 0% populated on every one of the last 10 trading dates
--   * technical_signals is a plain table, NOT a TimescaleDB hypertable, so DROP COLUMN is safe
--     here (it is not on the compressed-hypertable list in timescaledb_information.hypertables)
--
-- NOT dropped: screener_cat_breadth. Despite the shared prefix it is a DIFFERENT, live column --
-- written by screener_features_fetcher.py and read by ml_ensemble.py (as X['screener_breadth']),
-- exit_policy.py and screeners.router.ts.
--
-- Why these are not worth building a writer for instead: the concept is per-category screener
-- counts, and .claude/rules/measurement.md has already graded that family end to end -- bullish
-- screener consensus IC -0.027 (t=-2.36, significantly NEGATIVE), 0 of 1,563 individual
-- screeners survive FDR or Bonferroni, the sentiment labels are themselves inverted, and
-- screener_breadth (the closest measured analogue, and the surviving sibling above) came back
-- not significant. Populating a finer slice of a measured-negative family is not a gap worth
-- closing; leaving the columns in place just re-flags them as one at every future audit.
ALTER TABLE technical_signals DROP COLUMN IF EXISTS screener_cat_earnings;
ALTER TABLE technical_signals DROP COLUMN IF EXISTS screener_cat_inst_flow;
ALTER TABLE technical_signals DROP COLUMN IF EXISTS screener_cat_momentum;
ALTER TABLE technical_signals DROP COLUMN IF EXISTS screener_cat_breakout;
ALTER TABLE technical_signals DROP COLUMN IF EXISTS screener_cat_valuation;
ALTER TABLE technical_signals DROP COLUMN IF EXISTS screener_cat_reversal;

-- Down Migration
--
-- Restores the columns as NULL. The data is not recoverable because there never was any --
-- they were 0% populated for their entire existence.
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS screener_cat_earnings  REAL;
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS screener_cat_inst_flow REAL;
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS screener_cat_momentum  REAL;
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS screener_cat_breakout  REAL;
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS screener_cat_valuation REAL;
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS screener_cat_reversal  REAL;
