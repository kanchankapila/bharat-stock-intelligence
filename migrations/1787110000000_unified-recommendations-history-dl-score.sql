-- Up Migration
--
-- `unified_ranker.py` blends EIGHT engines (ENGINE_TO_SCORE_COL: screener, ml, cs, confluence,
-- technical, dl, breakout, smart_money). `unified_recommendations` stores all eight reporting
-- columns; its append-only snapshot twin `unified_recommendations_history` stored only seven --
-- `dl_score` was never added.
--
-- Consequence, found 2026-08-21 while decomposing unified_score against its own inputs: the
-- ranker's own audit table cannot reconstruct the ranker's own blend. `_blend()` renormalizes
-- weights over the engines PRESENT for a symbol, so dropping one engine (weight 0.137 in
-- HIGH_VOL, 0.093 in SIDEWAYS) changes every reconstructed score. The tell was arithmetic: the
-- implied multiplier `unified_score / reconstructed_blend` came out at p90 = 1.287 / p95 = 1.618,
-- which is impossible when every post-blend multiplier in unified_ranker.py is <= 1.0
-- (quality_gate <= 1, RED_FLAG_VETO_MULT 0.5, HIGH_VOL_VETO_MULT 0.7, crowding 0.9). The gap was
-- the missing engine, not the ranker.
--
-- Until this column is populated, no one can measure what the non-linear assembly layer
-- (quality gate / red-flag veto / high-vol veto / factor-crowding discount) does to the blend --
-- which is the open question in .claude/rules/measurement.md's shared-ceiling section.
--
-- Backfill is deliberately NOT attempted: history rows are immutable snapshots of what a past
-- run produced, and dl_score for those runs was never captured anywhere. Writing a
-- reconstructed value would fabricate evidence into the exact table that exists to prevent
-- that. Rows before this migration keep dl_score NULL and are simply not usable for the
-- decomposition; rows after it are.

ALTER TABLE unified_recommendations_history
  ADD COLUMN IF NOT EXISTS dl_score DOUBLE PRECISION;

COMMENT ON COLUMN unified_recommendations_history.dl_score IS
  'dl_engine.py prob_up_5d x 100, the 8th blended engine. Added 2026-08-21; NULL for snapshots '
  'taken before that date (never captured, deliberately not backfilled). Without it the blend '
  'cannot be reconstructed from this table -- see measurement.md.';

-- Down Migration
ALTER TABLE unified_recommendations_history DROP COLUMN IF EXISTS dl_score;
