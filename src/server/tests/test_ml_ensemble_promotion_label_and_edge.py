"""promote_or_register()'s two "the baseline's CV is not evidence" overrides, added 2026-08-21.

Both exist because the CV comparison itself is the bug in these two states:

  (a) label changed  -- CV AUC is only comparable within one target. The triple-barrier label
      (vol-scaled +2/-1 ATR barriers with a cost band, ~36% base rate) is a strictly harder
      question than the horizon label (path_barrier / max-favourable-excursion, ~88% win rate
      at h=15), so a horizon baseline's 0.7664 is unbeatable by construction, not on merit.
      Without this, flipping the platform to the honest label would silently freeze promotion
      forever.
  (b) live edge unproven -- the incumbent's realized forward edge is chance, so its CV number
      measures overfit. staleness_override_applies() cannot catch this: a model that keeps
      winning on CV never accumulates the rejections that override requires.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ml_ensemble


# The real live reading for technical_signals.win_probability, 2026-08-21.
DEAD_EDGE = {"rank_ic": 0.1004, "hit_auc": 0.5351, "dates": 34}
REAL_EDGE = {"rank_ic": 0.0800, "hit_auc": 0.5800, "dates": 40}
# model_registry id=220: best CV of all 59 registered ensemble candidates.
INCUMBENT = {"id": 220, "cv_auc": 0.7664, "test_auc": 0.6767,
             "trained_at": "2026-08-09T16:22:07+00:00", "label": "horizon"}


@pytest.fixture
def gate(monkeypatch, tmp_path):
    """Drive the real promote_or_register(), stubbing only its I/O edges. Returns a dict the
    test reads back: what got registered, and whether it was activated."""
    seen = {}

    def _register(conn, ensemble, activate=True, model_path=None, notes=None):
        seen["activate"] = activate
        seen["notes"] = notes
        seen["label"] = ensemble.get("label")
        return 999

    monkeypatch.setattr(ml_ensemble, "register_model", _register)
    monkeypatch.setattr(ml_ensemble, "save_ensemble", lambda e: seen.setdefault("saved", True))
    monkeypatch.setattr(ml_ensemble, "ENSEMBLE_PATH", str(tmp_path / "ensemble.pkl"))
    monkeypatch.setattr(ml_ensemble, "CANDIDATE_PATH", str(tmp_path / "ensemble.pkl.candidate"))
    monkeypatch.setattr(ml_ensemble, "rejections_since", lambda *a, **k: 0)
    return seen


def _run(monkeypatch, baseline, edge, candidate):
    monkeypatch.setattr(ml_ensemble, "_active_baseline", lambda conn: baseline)
    monkeypatch.setattr(ml_ensemble, "live_edge_verdict", lambda conn, t, c: edge)
    return ml_ensemble.promote_or_register(object(), candidate)


class TestLabelChangeUnblocksPromotion:
    def test_triple_barrier_candidate_is_not_rejected_against_horizon_baseline(
            self, monkeypatch, gate):
        # A weaker CV (0.62 << 0.7664) on the harder, honest label must still promote.
        _run(monkeypatch, INCUMBENT, REAL_EDGE,
             {"cv_auc": 0.62, "test_auc": 0.60, "label": "triple_barrier"})
        assert gate["activate"] is True, (
            "a triple_barrier candidate was rejected against a horizon baseline -- the CV "
            "numbers grade different targets and are not comparable")

    def test_same_label_still_enforces_the_cv_bar(self, monkeypatch, gate):
        # The control: the override must not become a blanket bypass. Same label + a real live
        # edge => a worse candidate is still rejected.
        _run(monkeypatch, INCUMBENT, REAL_EDGE,
             {"cv_auc": 0.62, "test_auc": 0.60, "label": "horizon"})
        assert gate["activate"] is False
        assert "REJECTED" in gate["notes"]


class TestLiveEdgeUnblocksPromotion:
    def test_chance_level_incumbent_cannot_defend_its_cv(self, monkeypatch, gate):
        _run(monkeypatch, INCUMBENT, DEAD_EDGE,
             {"cv_auc": 0.62, "test_auc": 0.60, "label": "horizon"})
        assert gate["activate"] is True

    def test_ungraded_incumbent_still_defends_its_cv(self, monkeypatch, gate):
        # No factor_edge_history reading at all must NOT be read as "no edge".
        _run(monkeypatch, INCUMBENT, None,
             {"cv_auc": 0.62, "test_auc": 0.60, "label": "horizon"})
        assert gate["activate"] is False

    def test_nan_candidate_never_rides_an_override(self, monkeypatch, gate):
        # `float(nan or 0.0)` is NaN, not 0.0 -- NaN is truthy. With the CV comparison
        # bypassed there is nothing else left to stop an unscoreable candidate going live.
        _run(monkeypatch, INCUMBENT, DEAD_EDGE,
             {"cv_auc": float("nan"), "test_auc": 0.60, "label": "triple_barrier"})
        assert gate["activate"] is False


class TestBootstrapUnchanged:
    def test_no_baseline_still_promotes(self, monkeypatch, gate):
        _run(monkeypatch, None, None, {"cv_auc": 0.61, "test_auc": 0.60, "label": "triple_barrier"})
        assert gate["activate"] is True
