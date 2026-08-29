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
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode
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


def file_staleness_override_applies(baseline_metrics: dict | None,
                                     max_days: float = DEFAULT_STALENESS_MAX_DAYS,
                                     max_rejections: int = DEFAULT_STALENESS_MAX_REJECTIONS
                                     ) -> Tuple[bool, float, int]:
    """Same safety valve as staleness_override_applies(), for the engines whose promotion
    gate persists to a local pickle/JSON file instead of model_registry (ml-promotion-gate-
    review, 2026-08-14: dl_engine.py, live_screener_ml_ranker.py, breakout_classifier.py,
    flyer_classifier.py, movement_predictor.py) -- rejections_since() needs a Postgres
    model_registry connection these files don't have, so they had no equivalent self-healing
    path at all: a stale baseline (e.g. inflated by a leak that's since been fixed) would
    reject every future honest retrain forever, same class of deadlock already found and
    fixed twice for the model_registry-backed engines (ensemble, cs_ranker).

    Rejection bookkeeping lives inside the baseline's own stored metrics dict:
    `first_rejected_at` (ISO string, set the first time a candidate is rejected against this
    exact baseline) and `rejection_count` (int, incremented on each subsequent rejection).
    The caller is responsible for writing the incremented fields back into the baseline
    file's metrics dict when a candidate is rejected, and for clearing both fields when a
    candidate IS promoted (the new baseline starts with a clean slate) -- this function only
    reads them and decides.

    Returns (override_applies, age_days, rejection_count) -- age_days/rejection_count are
    always returned (even when the override doesn't apply) so callers can log regardless of
    outcome. A baseline with no `first_rejected_at` yet (never been rejected) returns
    (False, 0.0, 0) -- age is meaningless before the first rejection is recorded."""
    if not baseline_metrics:
        return False, 0.0, 0
    rejection_count = int(baseline_metrics.get('rejection_count') or 0)
    first_rejected_at = baseline_metrics.get('first_rejected_at')
    if not first_rejected_at:
        return False, 0.0, rejection_count
    age_days = days_since(first_rejected_at)
    return (age_days >= max_days and rejection_count >= max_rejections), age_days, rejection_count


# ── Realized-forward-edge gate ────────────────────────────────────────────────
#
# A promotion gate built on a model's own self-reported CV/held-out AUC cannot tell a real
# edge from an overfit one. Measured live 2026-08-21: the active ensemble (model_registry
# id=220) held the BEST CV of all 59 registered ensemble candidates -- cv_roc_auc=0.7664 --
# while the same model's live output, graded against realized forward returns by
# factor_edge.py, scored hit_auc 0.493 / 0.512 / 0.535 at 1/5/21d. That is chance. A baseline
# whose realized edge is that weak is not evidence of anything, and letting its inflated CV
# block every honest challenger is the same permanent-deadlock failure that
# staleness_override_applies() above exists to break -- just sourced from overfitting rather
# than from a since-fixed leak, and therefore invisible to the age/rejection-count math (a
# model that keeps winning on CV never accumulates rejections, so it never goes "stale").
#
# Thresholds deliberately mirror factor_edge.py's own _verdict(): USABLE requires
# |rank_IC| >= 0.03 AND hit_AUC >= 0.55, and a reading under MIN_DATES_RELIABLE=20 dates is
# LOW-DATA. Keeping one bar means "the gate says the incumbent has no edge" and "measurement.md
# says the incumbent has no edge" can never disagree.

LIVE_EDGE_MIN_IC = 0.03
LIVE_EDGE_MIN_AUC = 0.55
LIVE_EDGE_MIN_DATES = 20


def live_edge_verdict(conn, table_name: str, score_col: str) -> Optional[dict]:
    """Realized-forward-return reading for a scored column, from the most recent factor_edge.py
    run recorded in factor_edge_history.

    Takes the BEST horizon of that run (MAX over rank_ic/hit_auc/dates), deliberately: this
    reading is used to decide whether an incumbent's edge is too weak to defend its CV baseline,
    so being generous to the incumbent keeps the override conservative -- it can only fire when
    even the incumbent's best horizon fails.

    Returns None if the column has never been graded."""
    try:
        row = conn.execute(
            "SELECT MAX(rank_ic), MAX(hit_auc), MAX(dates) FROM factor_edge_history "
            "WHERE table_name = ? AND score_col = ? AND run_at = ("
            "  SELECT MAX(run_at) FROM factor_edge_history "
            "  WHERE table_name = ? AND score_col = ?)",
            (table_name, score_col, table_name, score_col),
        ).fetchone()
    except Exception:
        # A failed SELECT aborts the whole transaction on Postgres -- roll back or every later
        # query on this shared conn dies with "current transaction is aborted".
        try:
            conn.rollback()
        except Exception:
            pass
        return None
    if not row or row[0] is None or row[1] is None:
        return None
    return {'rank_ic': float(row[0]), 'hit_auc': float(row[1]), 'dates': int(row[2] or 0)}


def live_edge_is_unproven(verdict: Optional[dict],
                           min_ic: float = LIVE_EDGE_MIN_IC,
                           min_auc: float = LIVE_EDGE_MIN_AUC,
                           min_dates: int = LIVE_EDGE_MIN_DATES) -> Tuple[bool, str]:
    """(is_unproven, reason) for a live_edge_verdict() reading.

    "Unmeasured" is NOT the same as "measured and bad", and this returns False for both the
    never-graded and the too-thin case on purpose: a newly-scored column with 3 dates behind it
    must not be allowed to override its own baseline on no evidence. Only a reading with
    >= min_dates dates that still fails the USABLE bar counts as unproven."""
    if not verdict:
        return False, "no realized-edge reading yet"
    if verdict['dates'] < min_dates:
        return False, f"realized-edge reading too thin ({verdict['dates']} dates < {min_dates})"
    if abs(verdict['rank_ic']) >= min_ic and verdict['hit_auc'] >= min_auc:
        return False, (f"live edge holds (rank_ic={verdict['rank_ic']:.4f}, "
                        f"hit_auc={verdict['hit_auc']:.4f}, {verdict['dates']} dates)")
    return True, (f"live rank_ic={verdict['rank_ic']:.4f} / hit_auc={verdict['hit_auc']:.4f} over "
                   f"{verdict['dates']} dates fails IC>={min_ic} AND AUC>={min_auc}")

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
