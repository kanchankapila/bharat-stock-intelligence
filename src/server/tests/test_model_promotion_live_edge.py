"""Tests for model_promotion.live_edge_verdict() / live_edge_is_unproven() -- the realized-
forward-return promotion gate added 2026-08-21.

Why it exists: measured live that day, the active ensemble (model_registry id=220) held the
BEST CV of all 59 registered ensemble candidates (cv_roc_auc=0.7664) while the very same
model's live output scored hit_auc 0.493/0.512/0.535 at 1/5/21d in factor_edge_history --
chance. staleness_override_applies() cannot break that deadlock, because a model that keeps
winning on CV never accumulates the rejections that override needs.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from model_promotion import (live_edge_verdict, live_edge_is_unproven,
                             LIVE_EDGE_MIN_IC, LIVE_EDGE_MIN_AUC, LIVE_EDGE_MIN_DATES)


class _FakeCursor:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _FakeConn:
    """Records the SQL it was handed so the test can assert the run_at scoping is real."""

    def __init__(self, row=None, raise_on_execute=False):
        self._row = row
        self._raise = raise_on_execute
        self.sql = None
        self.params = None
        self.rolled_back = False

    def execute(self, sql, params=None):
        self.sql, self.params = sql, params
        if self._raise:
            raise RuntimeError("relation \"factor_edge_history\" does not exist")
        return _FakeCursor(self._row)

    def rollback(self):
        self.rolled_back = True


class TestLiveEdgeVerdict:
    def test_reads_best_horizon_of_the_latest_run(self):
        conn = _FakeConn(row=(0.1004, 0.5351, 34))
        v = live_edge_verdict(conn, "technical_signals", "win_probability")
        assert v == {"rank_ic": pytest.approx(0.1004), "hit_auc": pytest.approx(0.5351), "dates": 34}
        # Must scope to the most recent run, not pool every run ever recorded.
        assert "MAX(run_at)" in conn.sql
        assert conn.params == ("technical_signals", "win_probability",
                               "technical_signals", "win_probability")

    def test_never_graded_returns_none(self):
        assert live_edge_verdict(_FakeConn(row=(None, None, None)), "t", "c") is None
        assert live_edge_verdict(_FakeConn(row=None), "t", "c") is None

    def test_query_failure_rolls_back_and_returns_none(self):
        # A failed SELECT aborts the whole transaction on Postgres; without the rollback every
        # later query on the shared conn dies with "current transaction is aborted".
        conn = _FakeConn(raise_on_execute=True)
        assert live_edge_verdict(conn, "t", "c") is None
        assert conn.rolled_back is True


class TestLiveEdgeIsUnproven:
    def test_the_real_incumbent_reading_is_unproven(self):
        """The actual live reading for technical_signals.win_probability on 2026-08-21."""
        unproven, reason = live_edge_is_unproven(
            {"rank_ic": 0.1004, "hit_auc": 0.5351, "dates": 34})
        assert unproven is True
        assert "0.5351" in reason

    def test_a_real_edge_is_defended(self):
        unproven, _ = live_edge_is_unproven({"rank_ic": 0.08, "hit_auc": 0.58, "dates": 40})
        assert unproven is False

    def test_never_graded_is_not_unproven(self):
        # "Unmeasured" must never be treated as "measured and bad" -- otherwise a brand-new
        # scored column overrides its own baseline on no evidence at all.
        unproven, reason = live_edge_is_unproven(None)
        assert unproven is False
        assert "no realized-edge reading" in reason

    def test_thin_reading_is_not_unproven(self):
        unproven, reason = live_edge_is_unproven(
            {"rank_ic": 0.001, "hit_auc": 0.40, "dates": LIVE_EDGE_MIN_DATES - 1})
        assert unproven is False, "a LOW-DATA reading must not be allowed to override"
        assert "too thin" in reason

    def test_exactly_at_the_bar_is_defended(self):
        unproven, _ = live_edge_is_unproven(
            {"rank_ic": LIVE_EDGE_MIN_IC, "hit_auc": LIVE_EDGE_MIN_AUC,
             "dates": LIVE_EDGE_MIN_DATES})
        assert unproven is False

    def test_ic_clears_but_auc_fails_is_unproven(self):
        # The dominant shape in measurement.md: real rank IC, AUC stalled near chance.
        unproven, _ = live_edge_is_unproven({"rank_ic": 0.12, "hit_auc": 0.54, "dates": 30})
        assert unproven is True

    def test_negative_ic_counts_as_magnitude(self):
        # A significantly INVERTED score is not "no signal" -- mirrors factor_edge._verdict's
        # abs(rank_IC), which exists because momentum-style factors legitimately invert.
        unproven, _ = live_edge_is_unproven({"rank_ic": -0.20, "hit_auc": 0.60, "dates": 30})
        assert unproven is False
