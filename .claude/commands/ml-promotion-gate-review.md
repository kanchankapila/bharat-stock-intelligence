---
description: Review a model-training/promotion-gate script (champion/challenger comparison, CV setup, staleness override) against the "Models & measurement" bug classes in recurring-bugs.md — one script from a diff, or the full sweep across every promotion-gated engine
---

# ML Promotion-Gate Review

Read `.claude/rules/recurring-bugs.md`'s "Models & measurement" section and `measurement.md`'s
"already tested" table first. `trpc-surface-review` and `fetcher-accuracy-review` cover the
backend/data-source half of this codebase's recurring-bug surface; this is the equivalent for the
~30 Python ML engines that train, gate, or promote a model — a surface with at least six
independently-discovered bug classes on record and no dedicated review of its own.

## Scope

Derive the list from the source tree, not from memory of a prior pass:

```bash
grep -rlE "champion|challenger|promot|baseline.*beat|beats.*baseline" src/server/*.py | grep -viE "test_|__tests__"
grep -rlE "cv=[0-9]|TimeSeriesSplit|random_state=" src/server/*.py | grep -viE "test_|__tests__"
```

Union the two lists. As of 2026-08-14 this is ~20 files including `regime_detector.py`,
`cs_ranker.py`, `dl_engine.py`, `dl_trainer.py`, `flyer_classifier.py`, `ml_ensemble.py`,
`breakout_classifier.py`, `confluence_ml_engine.py`, `exit_policy.py`, `online_learner.py`. For a
single-file review from a diff, apply the checklist below to that file only.

## 1. Does the gate compare metrics at all, or just check the artifact ran?

A metric-based promotion gate cannot catch weight divergence or output saturation on its own —
all-NaN weights make validation *raise*, which a handler can swallow; a 70%-saturated model can
still report a good AUC. Check: does anything here inspect the artifact itself (weight
finiteness, output distribution / saturation rate), or only the summary metric the training run
reports about itself?

## 2. Is the metric even measuring what "better" means here?

**AUC can be excellent and useless** — `flyer_classifier` held AUC 0.81 with IC −0.041 (t=−9.02):
it measured *who* flies, not *when*, which is what actually gets traded on. For any classifier
being gated on AUC/accuracy, ask what the metric would say about a model that's confidently right
about the wrong thing (predicts a *correlate* of the target rather than the target), and whether
anything downstream would catch that — see `measurement.md`'s "grade every candidate factor
against BOTH tails" rule for the general version of this trap.

## 3. Nested CV / calibration — is a splitter object passed, or a bare int?

`cv=<int>` anywhere inside a time-series harness silently means `StratifiedKFold`, which shuffles
time order — found in `_base_models`' six `CalibratedClassifierCV(..., cv=3)` calls sitting
inside an outer `TimeSeriesSplit(gap=embargo)` loop: the *outer* embargo was enforced, the *inner*
calibration fit isotonic/sigmoid on folds containing future rows, and nothing about the code
looked wrong on read. Grep for `cv=` as a bare int anywhere `TimeSeriesSplit`/`gap=`/`embargo`
appears in the same file — pass the splitter object, not a count.

## 4. Is the split grouped the same way training will actually be served?

**Grouping training rows by day when scoring reads one snapshot is train/serve skew.** Found in 3
files; one measured `test_auc` 0.641 → 0.486 once made honest. Check what the CV/train-test split
groups on (`GroupKFold` key, or an implicit group via date-based slicing) against what a real
scoring call actually sees at inference time — same date, same symbol, but is it the same *row
selection logic*?

## 5. Run-to-run seed noise vs. the champion/challenger gap

**A champion/challenger gate is meaningless if seed noise is wider than the gap being judged.**
`regime_detector.train_hmm` fit one EM seed and compared it to the incumbent on held-out
likelihood; measured across 6 seeds, the spread (9.95–11.17) straddled the incumbent (11.02) — the
verdict was seed luck. If this script fits with a single `random_state=<n>`, check (or ask
whether anyone has checked) the metric's run-to-run spread across several seeds before trusting
any single comparison against a baseline. Fix is multiple restarts, picked by the **training**
objective — picking by the holdout metric is selecting on the gate's own metric and turns the
out-of-sample test in-sample.

## 6. Can a stale baseline become permanently unbeatable?

If this gate only promotes when the challenger beats a stored baseline, and the baseline is never
force-refreshed on a schedule independent of "did anything beat it yet," an unlucky first-mover
baseline can block every honest retrain indefinitely. Check whether there's a staleness override
(a max age after which the baseline gets replaced regardless of the comparison) — see
`model_promotion.staleness_override_applies` in memory for the precedent.

## 7. Does a freshness monitor watching this job's OUTPUT confuse "gated" with "broken"?

If this script only writes its output table when it wins the promotion gate, a freshness check
pointed at that table will read two consecutive correct rejections as "stale" — `strategy-optimizer`
did exactly this (`screener_weight_history` looked stale since 2026-08-03 while the job ran clean
weekly, correctly rejecting each time). Check the corresponding `dataQualityChecks.ts` entry
derives "last ran" from the latest of the output probe, a stored `_ran_at`, and
`job_heartbeat.last_success_at` — never the output table alone.

## 8. Report

Named findings only — file, line, which of the 7 checks it fails, and whether the failure mode is
silent (wrong model promoted with no error) or loud (training crashes, gate blocks everything).
A promotion-gate change is signal/scoring-surface for `verify-gate.mjs`'s purposes if it touches
`unified_ranker.py`/`scoring_engine.py`/`multi_factor_scorer.py`/`institutional_quant_engine.py` —
it will demand backtest evidence before letting the session close; for engines outside that list,
still report whether this review's findings were live-verified (a real seed sweep run, a real
train/serve comparison) or are code-read hypotheses per `measurement.md`'s reverse-engineering
rule.
