"""
Shared champion/challenger model-promotion gate.

Seven training scripts (ml_ensemble.py, cs_ranker.py, confluence_ml_engine.py,
live_screener_ml_ranker.py, dl_engine.py, movement_predictor.py, breakout_classifier.py)
each independently decided whether a freshly trained model beats the currently active one
by enough margin to replace it. Six of the seven were found, one audit pass at a time
(Finding #17, 2026-07-28 full-stack audit), to be missing the gate entirely and had to be
retrofitted by hand -- because "does the new model beat the old one before I overwrite the
file" was never a shared, importable primitive. This is that primitive now.

Two call shapes exist across the seven sites, and BOTH are preserved here exactly rather
than merged into one "safer-looking" behavior, because the two sites that already do a
NaN/None check (movement_predictor.py, breakout_classifier.py) treat "no baseline yet" and
"invalid candidate metric" as different states on purpose (a NaN held-out AUC must never
auto-promote just because there happens to be no prior baseline to fail against), while the
other five sites' existing behavior does NOT special-case a NaN candidate -- changing that
would be a functional change, not a refactor, so it is deliberately not applied everywhere.
"""
import math
from typing import Optional, Tuple


def clears_promotion_bar(candidate_metric: Optional[float], baseline_metric: Optional[float],
                          margin: float) -> bool:
    """The bare comparison used (inline, un-extracted) by ml_ensemble.py's clears_cv_bar,
    cs_ranker.py, confluence_ml_engine.py, dl_engine.py, and live_screener_ml_ranker.py:
    promote if there is no baseline yet, or the candidate beats it by >= margin.

    `baseline_metric` must already be resolved to plain None for "no baseline" -- callers
    whose baseline is a dict/row object (e.g. `baseline.get("test_auc")`) resolve that
    themselves before calling, so this function stays agnostic to each site's storage shape.
    Does NOT special-case a NaN candidate_metric -- matches every one of these five sites'
    existing behavior (a NaN candidate compared against a real baseline naturally evaluates
    to False via Python's NaN-comparison semantics; a NaN candidate with no baseline yet
    naturally promotes, same as before this was extracted).
    """
    return baseline_metric is None or candidate_metric >= baseline_metric + margin


def decide_promotion_with_nan_guard(candidate_metric: Optional[float],
                                     baseline_metric: Optional[float],
                                     margin: float,
                                     metric_name: str = "test AUC") -> Tuple[bool, Optional[str]]:
    """The NaN-guarded (candidate, baseline) -> (promote, refusal_reason) shape already
    duplicated identically between movement_predictor.py's _movement_promotion_decision and
    breakout_classifier.py's _breakout_promotion_decision. Unlike clears_promotion_bar above,
    this refuses to promote a NaN/None candidate even with no baseline to compare against --
    that was each of those two sites' existing, deliberate behavior (a held-out AUC that
    couldn't be computed at all must never be treated as "automatically better than nothing").
    """
    if candidate_metric is None or (isinstance(candidate_metric, float) and math.isnan(candidate_metric)):
        return False, (f"held-out {metric_name} is NaN (insufficient holdout data) -- cannot "
                        f"confirm this model is safe to promote.")
    if baseline_metric is None:
        return True, None
    if candidate_metric >= baseline_metric + margin:
        return True, None
    return False, (f"new held-out {metric_name} {candidate_metric:.4f} did not beat active "
                    f"model's {baseline_metric:.4f} + {margin} margin.")
