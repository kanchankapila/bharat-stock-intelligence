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
import datetime
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


# ── Staleness override ────────────────────────────────────────────────────────
#
# ml_ensemble.py originally built this as a local, one-off mechanism (2026-07-28 audit,
# model_registry id=26: a baseline's CV score became permanently unbeatable after a data
# leak feeding it was fixed -- every honest retrain rejected forever against a number that
# was never real). cs_ranker.py and confluence_ml_engine.py had no equivalent at all, which
# is exactly how the same class of deadlock recurred for them (2026-08-06: cs_ranker's and
# ensemble's active baselines were both found still pointing at pre-leak-fix runs, with every
# honest post-fix retrain rejected against them, and neither model's promotion gate had any
# way to recover on its own). Generalized here so all three (and any future model_registry
# consumer) share one implementation instead of each hand-rolling its own age/rejection math.

DEFAULT_STALENESS_MAX_DAYS = 7
DEFAULT_STALENESS_MAX_REJECTIONS = 10


def days_since(trained_at) -> float:
    """Age in days of a model_registry `trained_at` value (str or datetime). Handles the
    tz-aware-vs-naive mismatch Postgres introduces (it returns tz-aware UTC datetimes;
    datetime.now() is naive by default) -- comparing the two directly raises, which without
    this guard silently produced an age of 0.0 for every Postgres-backed caller."""
    try:
        if isinstance(trained_at, str):
            trained_at = datetime.datetime.fromisoformat(trained_at)
        now = datetime.datetime.now(trained_at.tzinfo) if trained_at.tzinfo else datetime.datetime.now()
        return (now - trained_at).total_seconds() / 86400.0
    except Exception:
        return 0.0


def rejections_since(conn, model_name: str, baseline_id: int) -> int:
    """How many candidates have been registered (and rejected, is_active=0) against the
    given model_name since baseline_id -- i.e. how many consecutive honest retrains have
    failed to beat the current baseline."""
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM model_registry WHERE model_name = ? "
            "AND is_active = 0 AND id > ?", (model_name, baseline_id)
        ).fetchone()
        return int(row[0]) if row and row[0] is not None else 0
    except Exception:
        # A failed SELECT on a shared Postgres connection leaves the transaction aborted --
        # every later query on the same conn fails with "current transaction is aborted"
        # until rolled back (this exact class of bug recurs across this codebase's history).
        try:
            conn.rollback()
        except Exception:
            pass
        return 0


def staleness_override_applies(baseline_trained_at, rejections: int,
                                max_days: float = DEFAULT_STALENESS_MAX_DAYS,
                                max_rejections: int = DEFAULT_STALENESS_MAX_REJECTIONS
                                ) -> Tuple[bool, float]:
    """A candidate stuck behind a stale baseline forever (e.g. the baseline's score was
    inflated by a leak/bug that's since been fixed, so nothing can ever clear the promotion
    margin over it again) gets auto-adopted once the baseline has gone unbeaten this long.
    This is a safety valve, not a relaxation of the promotion bar itself -- it only fires
    after sustained, repeated rejection (both conditions, not either).

    Returns (override_applies, age_days) -- age_days is always returned (even when the
    override doesn't apply) so callers can log/report it regardless of outcome."""
    age_days = days_since(baseline_trained_at)
    return (age_days >= max_days and rejections >= max_rejections), age_days
