"""Realized edge, not self-reported CV, decides promotion.

The evidence that forces this, already recorded in measurement.md / ml-model-bugs.md:
the active ensemble held the BEST cv_roc_auc of all 59 registered candidates (0.7664) while
that same model, graded against realized forward returns in factor_edge_history, scored
hit_auc 0.493 / 0.512 / 0.535 at 1/5/21d. Chance. A gate whose only input is a number the
candidate computed about itself cannot detect overfitting -- and the better the overfit, the
harder that gate defends it.

`live_edge_verdict` already existed but only as an OVERRIDE: it could let a candidate through
when the incumbent was demonstrably hollow. It could not stop one getting in on CV alone, which
is the direction that actually causes harm.

The precedence implemented here:
  1. A candidate with a non-finite CV is never promoted (nothing else is left to catch it, and
     `float(nan or 0.0)` is NaN -- this codebase's own recurring truthiness trap).
  2. No incumbent -> promote; there is nothing to defend.
  3. Incumbent's label differs, or its realized edge is measured-and-failing -> its CV is not
     evidence, so it cannot block. Promote (pre-existing behaviour, kept).
  4. Incumbent has a PROVEN realized edge -> CV superiority alone must NOT displace it. This is
     the new bar, and the whole point: beating a proven live edge has to be demonstrated live.
  5. Incumbent is UNGRADED or its reading is too thin -> refuse, and say so. Previously CV
     decided by default here, which is the exact hole the 0.7664-vs-0.50 incident came through.
     The staleness override remains the escape hatch so this cannot deadlock forever.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from model_promotion import promotion_decision

PROVEN = {"rank_ic": 0.08, "hit_auc": 0.57, "dates": 40}
FAILING = {"rank_ic": 0.001, "hit_auc": 0.50, "dates": 40}
THIN = {"rank_ic": 0.30, "hit_auc": 0.80, "dates": 3}


def d(**kw):
    base = dict(candidate_cv=0.62, baseline_cv=0.55, clears_cv_bar=True, clears_test_gate=True,
                label_changed=False, edge=PROVEN, staleness_override=False, has_baseline=True)
    base.update(kw)
    return promotion_decision(**base)


def test_a_proven_live_edge_cannot_be_displaced_by_cv_alone():
    """The core change. Candidate CV 0.62 crushes baseline 0.55 -- and is refused."""
    r = d(candidate_cv=0.62, baseline_cv=0.55, edge=PROVEN)
    assert r.promote is False
    assert "realized" in r.reason.lower() or "live" in r.reason.lower()


def test_an_incumbent_whose_live_edge_fails_cannot_block():
    r = d(edge=FAILING)
    assert r.promote is True


def test_a_changed_label_still_bypasses_the_cv_comparison():
    """CV is only comparable within one target; a triple_barrier candidate must not be judged
    against a path_barrier baseline's inflated number."""
    r = d(label_changed=True, clears_cv_bar=False, edge=PROVEN)
    assert r.promote is True


def test_an_ungraded_incumbent_does_not_let_cv_decide():
    """The hole the 0.7664-vs-0.50 incident came through: nobody had graded the incumbent, so
    the CV margin was the only input and it was measuring overfit."""
    r = d(edge=None, clears_cv_bar=True)
    assert r.promote is False
    assert "graded" in r.reason.lower() or "unmeasured" in r.reason.lower()


def test_a_reading_below_the_reliability_floor_is_not_treated_as_proof_either_way():
    r = d(edge=THIN, clears_cv_bar=True)
    assert r.promote is False, "3 dates is not evidence of an edge, in either direction"


def test_staleness_override_still_breaks_a_deadlock():
    """Without this, an ungraded incumbent could never be replaced."""
    r = d(edge=None, clears_cv_bar=False, staleness_override=True)
    assert r.promote is True


def test_no_baseline_promotes():
    r = d(has_baseline=False, edge=None, clears_cv_bar=False)
    assert r.promote is True


def test_a_nan_candidate_is_never_promoted_by_any_route():
    """Every override must be subordinate to this -- with the CV comparison bypassed there is
    nothing else left to catch a diverged model."""
    for kw in ({"edge": FAILING}, {"label_changed": True}, {"staleness_override": True},
               {"has_baseline": False}):
        r = d(candidate_cv=float("nan"), **kw)
        assert r.promote is False, f"NaN candidate promoted via {kw}"


def test_the_test_auc_gate_blocks_only_while_the_baseline_is_trustworthy():
    """CORRECTED after the existing suite refuted the first version of this test.

    I had asserted that a failing test-AUC gate blocks even a promotable candidate. It must
    not: clears_test_gate is a BASELINE-RELATIVE comparison, exactly like clears_cv_bar, so an
    incumbent whose realized edge is chance cannot defend itself with a second self-reported
    number after the first was disqualified. test_ml_ensemble_promotion_label_and_edge.py
    caught this by driving the real promote_or_register()."""
    assert d(edge=FAILING, clears_test_gate=False).promote is True
    assert d(label_changed=True, clears_test_gate=False).promote is True
    # ...but a TRUSTWORTHY incumbent's test gate still blocks.
    assert d(edge=PROVEN, clears_test_gate=False).promote is False
