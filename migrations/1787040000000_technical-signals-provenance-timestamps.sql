-- Up Migration
--
-- technical_signals.created_at / updated_at existed in the schema but were 100% NULL on all
-- 73,563 rows -- they had no DEFAULT and no writer ever set them. (computed_at, by contrast, is
-- 100% populated for exactly one reason: it already carries DEFAULT now().)
--
-- This is not cosmetic. On 2026-08-15 it made a look-ahead defect invisible: win_probability is
-- written by a LATER `UPDATE` than the row's creation, so answering "was this value knowable
-- before the next session's open?" needs the UPDATE time. computed_at only records the row's
-- birth -- a lower bound, which cannot prove a later write happened in time. With the only
-- columns that could have answered it dead, the question was traced through the job scheduler
-- instead, and the naive reading (computed_at looks same-day, therefore fine) produced a
-- confident, wrong "win_probability has forward edge, IC +0.0364, t=+2.58" result that had to be
-- retracted. See .claude/rules/recurring-bugs.md, "a column written by a job that TRAINS and
-- then SCORES in the same invocation".
--
-- created_at: DEFAULT only. updated_at: DEFAULT plus a BEFORE UPDATE trigger, since a default
-- fires on INSERT alone and the whole point here is to capture the later enrichment writes.
--
-- Deliberately NOT backfilling the 73,563 existing rows. We genuinely do not know when they were
-- written; stamping them with now() (or with computed_at) would fabricate provenance, which is
-- strictly worse than an honest NULL for a column whose entire purpose is auditing write times.
-- Historical rows stay NULL and are knowingly ungradeable.
--
-- technical_signals is NOT a hypertable (verified against timescaledb_information.hypertables),
-- so ALTER + trigger here carry none of the compressed-chunk hazards migration-safety-review
-- flags for stock_ohlcv / feature_store / confluence_signals / intraday_ohlcv / tick_data.

ALTER TABLE technical_signals ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE technical_signals ALTER COLUMN updated_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS technical_signals_set_updated_at ON technical_signals;
CREATE TRIGGER technical_signals_set_updated_at
  BEFORE UPDATE ON technical_signals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS technical_signals_set_updated_at ON technical_signals;
ALTER TABLE technical_signals ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE technical_signals ALTER COLUMN updated_at DROP DEFAULT;
-- set_updated_at() is intentionally left in place: it is generic and other tables may adopt it.
