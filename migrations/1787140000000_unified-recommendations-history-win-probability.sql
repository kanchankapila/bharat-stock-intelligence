-- Up Migration
--
-- Gap #5 enabler: unified_ranker sizes every position through bet_size_from_probability()
-- on the ML ensemble's win_probability (the meta-label P(the long signal is correct)), but
-- its append-only snapshot table never stored that input -- only the DERIVED ml_score and
-- position_size_pct. Without the raw probability in history, neither past sizing decisions
-- nor the planned meta-model (realized outcome vs claimed confidence, López de Prado's
-- meta-labeling loop) can be reconstructed from the ranker's own audit trail -- the same
-- reconstruction failure the dl_score migration (1787110000000) fixed for the blend itself.
--
-- Written from UnifiedRanker.run()'s in-scope win_probs map each run; NULL when the
-- ensemble had no finite calibrated probability for the symbol (e.g. isotonic-collapse days).
--
-- Backfill is deliberately NOT attempted, mirroring the dl_score migration: snapshots are
-- immutable records of what a past run produced, and the probability behind pre-migration
-- rows was never captured anywhere.

ALTER TABLE unified_recommendations_history
  ADD COLUMN IF NOT EXISTS win_probability DOUBLE PRECISION;

COMMENT ON COLUMN unified_recommendations_history.win_probability IS
  'ml_ensemble calibrated_win_probability x 1 (NOT x100 like *_score cols), the meta-label '
  'behind position_size_pct via bet_size_from_probability(). Added 2026-08-24; NULL for '
  'snapshots before that date (never captured, deliberately not backfilled) or when the '
  'ensemble emitted no finite probability for the symbol.';

-- Down Migration
ALTER TABLE unified_recommendations_history DROP COLUMN IF EXISTS win_probability;
