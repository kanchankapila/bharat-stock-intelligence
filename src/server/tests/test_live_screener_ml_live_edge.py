"""
Regression tests for the live-edge promotion gate added to live_screener_ml_ranker.py
on 2026-07-31.

The deployed model reported a held-out test_auc of 0.6408 while its LIVE AUC -- its stored
probabilities graded against realised outcomes -- was 0.3778 over 47,559 rows: not merely
skill-less but anti-predictive. The promotion gate was selecting models on a metric that
demonstrably did not transfer, so a small held-out gain was being treated as evidence.
"""

import os
import sys

import pandas as pd
import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import live_screener_ml_ranker as lsr


def _frame(pairs):
    """pairs = [(win_probability, realised_return), ...]"""
    return pd.DataFrame({"wp": [p for p, _ in pairs], "ret": [r for _, r in pairs]})


def _patch_read_df(monkeypatch, result):
    monkeypatch.setattr(lsr, "read_df", lambda *a, **k: result)


class TestLiveAuc:
    def test_perfectly_ranked_scores_give_auc_one(self, monkeypatch):
        n = lsr.LIVE_AUC_MIN_ROWS
        pairs = [(0.9, 1.0)] * (n // 2) + [(0.1, -1.0)] * (n // 2)
        _patch_read_df(monkeypatch, _frame(pairs))
        auc, rows = lsr._live_auc()
        assert auc == pytest.approx(1.0)
        assert rows == n

    def test_inverted_scores_give_auc_below_half(self, monkeypatch):
        """The measured production state: highest-confidence picks underperform."""
        n = lsr.LIVE_AUC_MIN_ROWS
        pairs = [(0.9, -1.0)] * (n // 2) + [(0.1, 1.0)] * (n // 2)
        _patch_read_df(monkeypatch, _frame(pairs))
        auc, _rows = lsr._live_auc()
        assert auc == pytest.approx(0.0)
        assert auc < lsr.LIVE_AUC_FLOOR

    def test_thin_sample_returns_none(self, monkeypatch):
        _patch_read_df(monkeypatch, _frame([(0.9, 1.0), (0.1, -1.0)]))
        auc, rows = lsr._live_auc()
        assert auc is None and rows == 2

    def test_empty_frame_returns_none(self, monkeypatch):
        _patch_read_df(monkeypatch, pd.DataFrame(columns=["wp", "ret"]))
        assert lsr._live_auc() == (None, 0)

    def test_single_class_window_returns_none_not_a_crash(self, monkeypatch):
        """AUC is undefined when every outcome has the same sign -- must degrade, not raise."""
        n = lsr.LIVE_AUC_MIN_ROWS
        _patch_read_df(monkeypatch, _frame([(0.5, 1.0)] * n))
        auc, rows = lsr._live_auc()
        assert auc is None and rows == n

    def test_db_error_degrades_quietly(self, monkeypatch):
        def _boom(*a, **k):
            raise RuntimeError("relation does not exist")
        monkeypatch.setattr(lsr, "read_df", _boom)
        assert lsr._live_auc() == (None, 0)


class TestPromotionMarginPolicy:
    """The margin selection logic as applied in train(). Reproduced here as the pure decision
    it is, so the policy is pinned independently of the training pipeline around it."""

    @staticmethod
    def _margin(live_auc):
        live_edge_proven = live_auc is not None and live_auc >= lsr.LIVE_AUC_FLOOR
        return (lsr.PROMOTION_MARGIN
                if (live_auc is None or live_edge_proven)
                else lsr.STRICT_PROMOTION_MARGIN)

    def test_unproven_live_edge_raises_the_bar(self):
        assert self._margin(0.3778) == lsr.STRICT_PROMOTION_MARGIN

    def test_confirmed_live_edge_uses_the_standard_bar(self):
        assert self._margin(0.60) == lsr.PROMOTION_MARGIN

    def test_unmeasurable_live_edge_uses_the_standard_bar(self):
        """No live history yet must not permanently freeze the model -- that would be the
        same trap as blocking promotion outright."""
        assert self._margin(None) == lsr.PROMOTION_MARGIN

    def test_strict_margin_is_materially_larger(self):
        assert lsr.STRICT_PROMOTION_MARGIN > lsr.PROMOTION_MARGIN

    def test_floor_is_above_chance(self):
        assert lsr.LIVE_AUC_FLOOR > 0.5

    def test_measured_production_auc_would_be_gated(self):
        """0.3778 is the real measured value; pin that it does not pass."""
        assert 0.3778 < lsr.LIVE_AUC_FLOOR
        assert self._margin(0.3778) == lsr.STRICT_PROMOTION_MARGIN
