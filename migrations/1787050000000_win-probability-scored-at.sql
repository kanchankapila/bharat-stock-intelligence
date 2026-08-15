-- Up Migration
--
-- Per-COLUMN write provenance for the one column class that is actually graded as a forward
-- signal. Migration 1787040000000 gave technical_signals a working `updated_at`, which is enough
-- to notice gross problems (a Monday row updated the following Sunday is unmissable) but is a
-- row-level upper bound: it moves whenever ANY of ~300 columns changes, and ~15 enrichment jobs
-- touch these rows daily. It cannot answer "when was THIS column written", which is the only
-- question that decides whether a signal was knowable at a given entry time.
--
-- Deliberately NOT a generic solution. A per-column audit table would be ~73k rows x ~300 columns
-- (~22M rows) and a JSONB-diff trigger would compare 300 columns per row on every bulk UPDATE --
-- both are large costs to answer a question that only ~5 columns ever raise (win_probability,
-- cs_score, flyer_probability, movement_probability, breakout_*: the ML OUTPUT columns written by
-- a later pass than the row itself). This adds a stamp for win_probability, the column whose
-- untraceable write time produced the 2026-08-15 look-ahead retraction. The same one-line pattern
-- extends to the others if/when any of them is graded; do that then, not speculatively.
--
-- What this buys beyond auditability: `win_probability_scored_at - date` is now a MEASURABLE lag,
-- so the weekly-scoring cadence that caused the retraction becomes a data-quality check
-- (win-probability-scored-in-time) instead of something a human has to rediscover by grepping
-- queues.ts. See .claude/rules/recurring-bugs.md, "a column written by a job that TRAINS and then
-- SCORES in the same invocation".
--
-- Existing rows stay NULL, same reasoning as 1787040000000: their real write time is unknown and
-- inventing one would defeat the column's purpose. technical_signals is not a hypertable.

ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS win_probability_scored_at TIMESTAMPTZ;

COMMENT ON COLUMN technical_signals.win_probability_scored_at IS
  'When win_probability was written by ml_ensemble.py --score. NULL for rows written before '
  'migration 1787050000000. Compare against date to establish whether the signal was knowable '
  'before a given entry time -- see measurement.md''s retracted win_probability grading.';

-- Down Migration
ALTER TABLE technical_signals DROP COLUMN IF EXISTS win_probability_scored_at;
