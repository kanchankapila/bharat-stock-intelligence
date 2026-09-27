-- AF-20260927-08: regime_edge_weight() is driven by a MEASURED shrinkage slope, not by AUC
-- compared against a constant.
--
-- The gate applies p' = 0.5 + w*(p - 0.5), so w is a SCALE on win_probability. AUC measures
-- ordering and is blind to scale, and the two diverged badly in production: HIGH_VOL read a
-- stratified AUC of 0.648 at h=1 while its probabilities averaged 0.790 against a realized 0.403
-- base rate. Because AUC_TRUST_FLOOR (0.55) had been calibrated against the older POOLED AUC and
-- was never re-derived when per_regime_auc switched to a horizon-stratified one, every regime --
-- and the __GLOBAL__ fallback -- clipped to exactly w=1.0, making the gate a constant function and
-- edge_adjusted_probability a platform-wide no-op from 2026-09-25 15:43 IST.
--
-- calib_slope stores the Brier-optimal shrinkage, sum(d*(y-0.5))/sum(d*d) with d = p-0.5,
-- computed per (regime, horizon) and combined n-weighted -- horizon-stratified for the same
-- reason the AUC is (the WIN base rate is a property of the horizon: 38%/64%/79% at 1/5/15d).
-- It IS the optimum, so no threshold sits between the measurement and the weight, which removes
-- the class of bug above rather than re-tuning it.
--
-- Measured live 2026-09-27 (98,741-row panel): BEAR 0.469, CRASH 0.339, HIGH_VOL 0.812,
-- SIDEWAYS 0.346, __GLOBAL__ 0.555 -- i.e. win_probability is over-confident in every regime, and
-- in 10 of 14 regime x horizon strata the old w=1.0 scored WORSE by Brier than switching the
-- regime off entirely.
--
-- Nullable and additive on purpose: regime_edge_weight() falls back to the old AUC path for any
-- row whose slope is NULL, so this migration is inert until ml_calibration.py next runs and
-- backfills it. No data is rewritten.

ALTER TABLE regime_edge_status ADD COLUMN IF NOT EXISTS calib_slope REAL;
ALTER TABLE regime_edge_status ADD COLUMN IF NOT EXISTS calib_slope_n INTEGER;

COMMENT ON COLUMN regime_edge_status.calib_slope IS
  'Brier-optimal shrinkage weight for edge_adjusted_probability: sum(d*(y-0.5))/sum(d*d) with '
  'd = win_probability-0.5, horizon-stratified then n-weighted. <1 = over-confident, ~0 = no '
  'usable information, <0 = inverted scale. Drives regime_edge_weight(); AUC no longer does.';
COMMENT ON COLUMN regime_edge_status.calib_slope_n IS
  'Rows behind calib_slope, after per-stratum sample floors (AUC_MIN_STRATUM_N).';
