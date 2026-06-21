"""
Tests for relative_strength — cross-sectional universe-rank momentum.
Pure-function coverage of cross_sectional_rank and build_rs_features (no DB).
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from relative_strength import cross_sectional_rank, build_rs_features, filter_to_existing


class TestFilterToExisting:
    """run() must only UPDATE technical_signals rows that exist — computing rs for the whole
    universe then issuing 560k UPDATEs (of which ~5k match) is the slow path on Postgres."""

    def test_keeps_only_existing_pairs(self):
        feats = pd.DataFrame({
            "symbol": ["A", "B", "C"],
            "date":   ["2024-01-01", "2024-01-01", "2024-01-02"],
            "rs_rank_21d": [0.1, 0.2, 0.3],
        })
        existing = {("A", "2024-01-01"), ("C", "2024-01-02")}  # B has no technical_signals row
        out = filter_to_existing(feats, existing)
        assert list(out["symbol"]) == ["A", "C"]

    def test_empty_feats_returns_empty(self):
        out = filter_to_existing(pd.DataFrame(columns=["symbol", "date"]), {("A", "d")})
        assert out.empty

    def test_no_existing_pairs_drops_all(self):
        feats = pd.DataFrame({"symbol": ["A"], "date": ["d"], "rs_rank_21d": [0.5]})
        assert filter_to_existing(feats, set()).empty


class TestCrossSectionalRank:
    def test_rank_is_per_date_across_symbols(self):
        # 25 symbols on one date with ascending returns → top name ranks ~1.0, bottom ~0.04.
        cols = [f"S{i}" for i in range(25)]
        rets = pd.DataFrame([list(range(25))], columns=cols, index=["2024-01-01"])
        ranked = cross_sectional_rank(rets, min_universe=20)
        assert ranked.loc["2024-01-01", "S24"] == pytest.approx(1.0)
        assert ranked.loc["2024-01-01", "S0"] == pytest.approx(1 / 25)

    def test_thin_cross_section_is_dropped(self):
        # Only 3 names < min_universe → row left NaN (can't rank a universe of 3 fairly).
        rets = pd.DataFrame([[1.0, 2.0, 3.0]], columns=["A", "B", "C"], index=["d"])
        ranked = cross_sectional_rank(rets, min_universe=20)
        assert ranked.loc["d"].isna().all()

    def test_ranks_bounded_unit_interval(self):
        cols = [f"S{i}" for i in range(30)]
        rets = pd.DataFrame(np.random.randn(3, 30), columns=cols,
                            index=["d1", "d2", "d3"])
        ranked = cross_sectional_rank(rets, min_universe=20)
        assert ranked.min().min() >= 0.0 and ranked.max().max() <= 1.0


class TestBuildRSFeatures:
    def test_empty_input(self):
        out = build_rs_features(pd.DataFrame(columns=["symbol", "date", "close"]))
        assert out.empty

    def test_leader_outranks_laggard(self):
        # 25 symbols, 80 days. One symbol ramps hardest → top rs rank on the last date.
        dates = pd.bdate_range("2024-01-01", periods=80).strftime("%Y-%m-%d")
        rows = []
        for i in range(25):
            slope = 1.0 + i  # symbol 24 climbs fastest
            for d_idx, d in enumerate(dates):
                rows.append({"symbol": f"S{i}", "date": d, "close": 100 + slope * d_idx})
        out = build_rs_features(pd.DataFrame(rows))
        last = out[out["date"] == dates[-1]]
        leader = last[last.symbol == "S24"]["rs_rank_63d"].iloc[0]
        laggard = last[last.symbol == "S0"]["rs_rank_63d"].iloc[0]
        assert leader == pytest.approx(1.0)
        assert laggard < leader
        assert 0.0 <= laggard <= 1.0
