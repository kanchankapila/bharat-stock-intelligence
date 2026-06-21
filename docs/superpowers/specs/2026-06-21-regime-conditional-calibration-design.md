# Regime-Conditional Win-Probability Calibration (Option A)

_Design spec — 2026-06-21, branch `prod-readiness-phase1`. Quant/DS work on the ML feedback loop._

## Problem

Win rate on resolved signals varies enormously by market regime (live PG, WIN/LOSS only, joined
`signal_outcomes ⋈ technical_signals.nifty_regime`):

| regime | training samples | win rate |
|---|---|---|
| BEAR | 5,731 | 0.331 |
| SIDEWAYS | 2,079 | 0.610 |
| BULL | 1,523 | 0.583 |
| (null/unknown) | 1,000 | 0.497 |

Regime is the single biggest determinant of whether a signal wins. The shared ensemble averages
across these very different base rates, and its `win_probability` is calibrated **globally** — so
the same raw score maps to one win-probability regardless of regime. That dilutes sizing and the
0.40 gate, which both treat `win_probability` as a true probability.

A prior ablation (2026-06-21) showed that adding market-level VIX/breadth as **features** does not
help a per-stock cross-sectional classifier (it overfits the time axis). The right place for market
context is **conditioning**, not features. The lowest-risk, most data-efficient form of conditioning
that directly targets the measured effect (a base-rate shift) is **per-regime calibration**.

## Decision (as quant, user-approved)

Build **Option A — per-regime isotonic calibration + regime-fair gating + a per-regime AUC
diagnostic.** Do NOT build separate per-regime ensembles (B) or a per-regime meta-learner (C) yet:

- The purged walk-forward embargo is ~1,351 samples; BULL (1,523) and SIDEWAYS (2,079) cannot
  support a per-regime meta-learner or ensemble after that embargo.
- Regime days interleave in time, so per-regime temporal CV is leakage-prone and awkward.
- The 0.33↔0.61 spread is consistent with a pure base-rate shift, which calibration fixes optimally
  using all 13.5k samples. We have not yet measured whether feature *relationships* differ by regime.
- The per-regime AUC diagnostic (below) is exactly the evidence that would justify escalating to
  C/B later — escalate only with proof, not on assumption.

## Components & data flow

### 1. `ml_calibration.py` — per-regime calibration (modified)

`recalibrate_win_probabilities(conn, min_samples=200, min_regime_samples=300)`:

- Training query gains `ts.nifty_regime`:
  ```sql
  SELECT ts.nifty_regime AS regime,
         ts.win_probability AS p,
         CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
  FROM signal_outcomes so
  JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
  WHERE so.outcome IN ('WIN','LOSS') AND ts.win_probability IS NOT NULL
  ```
- Fit **one global** `IsotonicRegression` on all rows (existing behaviour, the fallback).
- Fit **one calibrator per regime** that has `≥ min_regime_samples` rows **and ≥ 2 outcome classes**;
  regimes failing either condition have **no** regime calibrator.
- Build the write set from
  `SELECT symbol, date, nifty_regime, win_probability FROM technical_signals WHERE win_probability IS NOT NULL`.
  For each row pick `regime_calibrators.get(regime, global_calibrator)` (null/thin/unknown regime →
  global) and write `calibrated_win_probability`. Idempotent (overwrites every run).
- Return `{fit: bool, n, updated, regimes: {regime: {n, used: 'regime'|'global'}}}` and print a
  one-line-per-regime summary.

Helpers `fit_calibrator(pred_probs, outcomes)` and `calibrate(ir, p)` are reused unchanged.

### 2. `ml_calibration.py` — `per_regime_auc(conn)` (new)

- Reads the same `regime, p (raw win_probability), y (WIN=1/LOSS=0)` rows.
- For each regime with `≥ 2` classes and `≥ min_regime_samples` rows, computes
  `sklearn.metrics.roc_auc_score(y, p)` on the **raw** `win_probability` (we want the shared model's
  *ranking* quality within the regime, independent of calibration).
- Returns `{regime: {n, auc}}`, prints one line per regime.
- Called at the end of `run()` after recalibration; result is logged (no new table in v1).
- **Interpretation (documented in the function docstring):** regime AUC well above 0.5 → the shared
  model ranks fine there, calibration is sufficient. Regime AUC ≈ 0.5 → the shared model cannot
  rank there; that regime is the candidate for a future per-regime model (escalation to C/B).

### 3. `scoring_engine.py` — regime-fair gate (modified)

The ML win-probability load (around line 490) currently selects raw `win_probability` and gates
`wp < 0.40`. Change the SELECT to
`MAX(COALESCE(calibrated_win_probability, win_probability)) AS wp` so the gate consumes the
per-regime-calibrated probability. The numeric 0.40 threshold is unchanged — once the probability is
honest per regime, a single threshold is already regime-fair (it naturally passes fewer BEAR
signals). `COALESCE` keeps rows that have not been calibrated yet working on the raw value.

### 4. Sizing — no change

`unified_ranker._get_win_probabilities` already reads
`AVG(COALESCE(calibrated_win_probability, win_probability))`, so per-regime calibration flows into
López-de-Prado position sizing automatically.

### 5. Cron — no change

`ml_calibration.py` already runs in `processMlDailyOps` after `scorePending`. Per-regime calibration
is a drop-in upgrade of that step.

## Explicitly out of scope (v1, YAGNI)

- **Per-regime threshold numbers** (a risk overlay that demands, e.g., 0.45 in BEAR beyond what
  calibration says). Calibration already makes a single threshold regime-fair; add per-regime
  thresholds only if a later drawdown/tail-risk analysis justifies extra BEAR conservatism.
- **Separate per-regime ensembles / meta-learner (C/B).** Gated behind the per-regime AUC evidence.
- **Persisting per-regime AUC to a table / model_registry.** Logged only in v1.

## Testing (TDD)

Pure-function and DB-backed tests in `src/server/tests/test_ml_calibration.py` (extend existing):

1. **Per-regime calibrators differ** — build two synthetic regimes whose raw-score→win-rate maps
   differ (e.g. regime A: high scores win; regime B: flat 0.5); assert the same raw score calibrates
   to different values under each regime's calibrator.
2. **Thin regime falls back to global** — a regime with `< min_regime_samples` rows is calibrated by
   the global calibrator (assert it gets the global mapping, not its own).
3. **One-class regime falls back to global** — a regime whose resolved outcomes are all WIN (or all
   LOSS) gets the global calibrator.
4. **Null/unknown regime falls back to global** — rows with `nifty_regime IS NULL` are calibrated.
5. **`per_regime_auc` distinguishes rankable vs random** — synthetic data where regime A is rankable
   (raw prob correlates with outcome, AUC > 0.6) and regime B is random (AUC ≈ 0.5); assert the
   returned dict reflects the difference.
6. **Gate reads calibrated** — unit/integration check that the scoring gate consumes
   `calibrated_win_probability` (a row whose raw `win_probability` is 0.6 but calibrated is 0.30 is
   gated out at the 0.40 threshold).

All DB-backed tests use an in-memory SQLite fixture mirroring the existing calibration/test pattern.

## Verification

- `npx vitest run` + full `pytest src/server/tests/` green.
- Live-PG run of `ml_calibration.py` (USE_POSTGRES=true): per-regime summary printed, all
  `calibrated_win_probability` rows updated, per-regime AUC reported for BEAR/SIDEWAYS/BULL.
- Confirm reliability per regime: within each regime, `AVG(calibrated_win_probability) ≈` the
  regime's empirical win rate (calibration sits on the diagonal per regime).
- Re-run `unified_ranker.py` and confirm sizing shifts (BEAR names sized smaller via honest lower
  calibrated probabilities).

## Risks / notes

- `nifty_regime` is produced by `technical_signals` (3-class) — the same column already used as a
  model feature; no dependency on the 5-state HMM `regime_detector` here.
- BEAR has the most data and the lowest win rate, so its calibrator is the most reliable and the one
  that most changes sizing/gating — the highest-value part of this change.
- If a future regime shows AUC ≈ 0.5 in the diagnostic, the escalation is C (per-regime meta-learner)
  for that regime only, designed in a separate spec.
