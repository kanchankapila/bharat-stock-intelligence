# Overdue measurements: rules fixed before any result (written 2026-11-28 12:14 IST)

No score, weight, label or model changes from any of these, whatever they read. Effective observations are
dates / horizon; under 20 the reading is LOW-DATA and supports no conclusion either way.

## AF-20261117-16: exit on a downgrade vs hold

`python plan_rule_measure.py --rule downgrade` (defaults: since 2026-09-01, h=5, 25 bps a side).
- DIFFERENT and exit-minus-hold above zero: meets the owner's bar for publishing exit signals (report; do not build).
- NO DIFFERENCE, or DIFFERENT and below zero, with 20 or more effective dates: close, do not publish.
- LOW-DATA: stays open with a recheck date.

## AF-20260829-12: screener_momentum_score after the 2026-08-29 relabel

`factor_edge.py`'s own loader and verdict on `technical_signals` rows dated 2026-08-31 or later, open entry,
horizons 1, 5, 10, not persisted. This harness applies no liquidity floor.
- This is a post-change reading only. The pre-change labels are not stored, so it cannot say whether the relabel
  helped or hurt, and it cannot close the row by itself.

## AF-20261008-22: drop-one ablation of the one-value-per-date feature block

- Rows: `ml_ensemble` triple-barrier training rows, `horizon_days = 5`, signal dates from 2026-06-30.
- Block: every `build_features` column that takes at most one value within every date and more than one across dates.
- Model (both arms, same rows): HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=4,
  min_samples_leaf=200, random_state=0). This is not the production ensemble.
- Walk-forward: first 40 dates train only; refit every 5 dates; the last 6 dates before each test block are purged.
- Primary metric: per-date Spearman IC of predicted probability against the 5-session open-entry return, names with
  20-day average turnover of Rs 1cr or more; difference (all features minus without the block) averaged over test dates.
- Verdict: under 20 effective dates LOW-DATA; otherwise the arms differ only if |t| >= 2 on the paired difference.
  A difference would be evidence about this block in a model of this kind, not a licence to change the ensemble.

## AF-20261008-39: GIFT series and BRENT / USDINR ret_5d

State read only (disagreement count, NULL counts). Nothing is changed before AF-20261008-22 has a powered result.

## Correction added after the results (the rules above are unchanged)

AF-20260829-12 says the pre-change labels are not stored. No database table keeps them, but `screener_scoring_v2.csv`
(2026-07-23) holds an earlier, partial set. It was not used in this run.
