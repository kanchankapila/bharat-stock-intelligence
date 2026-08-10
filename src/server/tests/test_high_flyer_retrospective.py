"""
Tests for high_flyer_retrospective — pure-function coverage of flyer detection,
precursor flags, lift computation, and candidate scoring (no DB).
"""

import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from high_flyer_retrospective import (
    detect_flyers,
    detect_divers,
    ohlcv_precursor_flags,
    ts_precursor_flags,
    compute_lifts,
    score_candidates,
    MIN_SUPPORT,
    _SELL_CLASSES,
    _BUY_CLASSES,
)


def _frames(n_days=80, flyer_ret=0.06, flyer_volx=3.0):
    """Universe of 3 symbols: FLY jumps +6% on 3x volume on the last day,
    FLAT does nothing, CHEAP is a penny stock that also jumps."""
    dates = pd.date_range("2026-01-01", periods=n_days, freq="B").strftime("%Y-%m-%d")
    base = np.full(n_days, 100.0)
    fly = base.copy(); fly[-1] = 100.0 * (1 + flyer_ret)
    cheap = np.full(n_days, 5.0); cheap[-1] = 5.5
    close = pd.DataFrame({"FLY": fly, "FLAT": base, "CHEAP": cheap}, index=dates)
    vol = pd.DataFrame(
        {"FLY": np.full(n_days, 1000.0), "FLAT": np.full(n_days, 1000.0),
         "CHEAP": np.full(n_days, 1000.0)}, index=dates)
    vol.iloc[-1, vol.columns.get_loc("FLY")] = 1000.0 * flyer_volx
    vol.iloc[-1, vol.columns.get_loc("CHEAP")] = 5000.0
    return close, vol


class TestDetectFlyers:
    def test_detects_big_move_on_volume(self):
        close, vol = _frames()
        out = detect_flyers(close, vol, close.index[-1])
        assert list(out["symbol"]) == ["FLY"]
        assert out.iloc[0]["return_pct"] == 6.0

    def test_penny_stock_excluded(self):
        close, vol = _frames()
        out = detect_flyers(close, vol, close.index[-1])
        assert "CHEAP" not in set(out["symbol"])

    def test_big_move_without_volume_not_flyer_unless_new_high(self):
        close, vol = _frames(flyer_volx=1.0)
        # +6% IS a new 252d high here (flat history), so still a flyer via that path
        out = detect_flyers(close, vol, close.index[-1])
        assert out.iloc[0]["new_52w_high"] == 1

    def test_short_history_excluded(self):
        close, vol = _frames(n_days=30)
        out = detect_flyers(close, vol, close.index[-1])
        assert out.empty

    def test_missing_day_returns_empty(self):
        close, vol = _frames()
        assert detect_flyers(close, vol, "1999-01-01").empty


def _diver_frames(n_days=80, diver_ret=-0.06, vol_x=3.0):
    """Mirror of _frames() for down-moves: DIVE crashes -6% on 3x volume."""
    dates = pd.date_range("2026-01-01", periods=n_days, freq="B").strftime("%Y-%m-%d")
    base = np.full(n_days, 100.0)
    dive = base.copy(); dive[-1] = 100.0 * (1 + diver_ret)
    close = pd.DataFrame({"DIVE": dive, "FLAT": base}, index=dates)
    vol = pd.DataFrame({"DIVE": np.full(n_days, 1000.0), "FLAT": np.full(n_days, 1000.0)}, index=dates)
    vol.iloc[-1, vol.columns.get_loc("DIVE")] = 1000.0 * vol_x
    return close, vol


class TestDetectDivers:
    def test_detects_big_down_move_on_volume(self):
        close, vol = _diver_frames()
        out = detect_divers(close, vol, close.index[-1])
        assert list(out["symbol"]) == ["DIVE"]
        assert out.iloc[0]["return_pct"] == -6.0

    def test_up_move_is_not_a_diver(self):
        close, vol = _frames()   # FLY jumps +6% — must never show up as a diver
        out = detect_divers(close, vol, close.index[-1])
        assert out.empty

    def test_short_history_excluded(self):
        close, vol = _diver_frames(n_days=30)
        assert detect_divers(close, vol, close.index[-1]).empty

    def test_new_52w_low_without_volume_still_a_diver(self):
        close, vol = _diver_frames(vol_x=1.0)
        # -6% on flat history IS a new 252d low, so still a diver via that path
        out = detect_divers(close, vol, close.index[-1])
        assert out.iloc[0]["new_52w_high"] == 1   # column reused to mean "new low" for divers


class TestWrongDirectionClassSets:
    """Guards against the exact string-matching typo class this repo has hit before
    (e.g. querying 'BUY' against a title-case 'Buy' column silently matches nothing)."""

    def test_sell_classes_match_unified_ranker_classify_output(self):
        # unified_ranker._classify emits title-case 'Sell'/'Strong Sell', never SCREAMING_CASE.
        assert _SELL_CLASSES == {"Sell", "Strong Sell"}

    def test_buy_classes_match_unified_ranker_classify_output(self):
        assert _BUY_CLASSES == {"Buy", "Strong Buy"}

    def test_hold_is_in_neither_class(self):
        assert "Hold" not in _SELL_CLASSES
        assert "Hold" not in _BUY_CLASSES


class TestOhlcvPrecursorFlags:
    def test_near_high_and_sma200(self):
        close, vol = _frames(n_days=260)
        flags = ohlcv_precursor_flags(close, vol, close.index[-2])
        assert bool(flags.loc["FLAT", "near_52w_high"])   # flat series sits at its high
        assert not bool(flags.loc["FLAT", "above_sma200"])  # equal, not above
        assert bool(flags.loc["FLAT", "tight_range_10d"])

    def test_vol_buildup(self):
        close, vol = _frames(n_days=260)
        vol.iloc[-7:-1, vol.columns.get_loc("FLY")] = 2000.0  # 5d avg 2x the 20d avg
        flags = ohlcv_precursor_flags(close, vol, close.index[-2])
        assert bool(flags.loc["FLY", "vol_buildup_5v20"])


class TestTsPrecursorFlags:
    def test_thresholds(self):
        ts = pd.DataFrame({
            "symbol": ["A", "B"],
            "rs_rank_63d": [0.9, 0.2],
            "rs_rank_21d": [0.5, None],
            "adx": [30, 10],
            "delivery_pct": [70, 20],
            "calibrated_win_probability": [0.6, 0.4],
            "screener_bull_count": [5, 0],
            "eps_beat_last_q": [1, 0],
            "insider_buy_flag": [None, None],
        })
        flags = ts_precursor_flags(ts)
        assert bool(flags.loc["A", "rs_rank_63d_top"])
        assert bool(flags.loc["A", "adx_trending"])
        assert bool(flags.loc["A", "calib_winprob_55"])
        assert not bool(flags.loc["B", "rs_rank_63d_top"])
        assert not bool(flags.loc["B", "insider_buying"])  # NaN → False

    def test_empty(self):
        assert ts_precursor_flags(pd.DataFrame()).empty


class TestComputeLifts:
    def test_lift_math(self):
        # 100 flyers of 1000 universe; precursor present in 50% of flyers, 10% of universe → lift 5
        rows = [{"flyer_n": 100, "universe_n": 1000,
                 "precursor_counts": {"p": {"universe": 100, "flyers": 50}}}]
        lifts = compute_lifts(rows)
        assert lifts["p"]["lift"] == 5.0
        assert lifts["p"]["support"] == 50

    def test_aggregates_across_days(self):
        rows = [{"flyer_n": 10, "universe_n": 100,
                 "precursor_counts": {"p": {"universe": 10, "flyers": 5}}}] * 4
        assert compute_lifts(rows)["p"]["support"] == 20

    def test_empty_or_zero(self):
        assert compute_lifts([]) == {}
        assert compute_lifts([{"flyer_n": 0, "universe_n": 0, "precursor_counts": {}}]) == {}


class TestScoreCandidates:
    def _lifts(self, lift=2.0, support=MIN_SUPPORT):
        return {"a": {"lift": lift, "support": support},
                "b": {"lift": 3.0, "support": support}}

    def test_scores_sum_of_log_lifts(self):
        flags = pd.DataFrame({"a": [True, False], "b": [True, True]}, index=["X", "Y"])
        out = score_candidates(flags, self._lifts())
        x = out[out["symbol"] == "X"].iloc[0]
        assert abs(x["score"] - (math.log(2.0) + math.log(3.0))) < 1e-3
        assert out.iloc[0]["symbol"] == "X"  # highest score first
        assert x["precursors"] == "a,b"

    def test_low_support_precursor_ignored(self):
        flags = pd.DataFrame({"a": [True]}, index=["X"])
        out = score_candidates(flags, self._lifts(support=MIN_SUPPORT - 1))
        assert out.empty or "a" not in out.iloc[0]["precursors"].split(",")

    def test_low_lift_precursor_ignored(self):
        flags = pd.DataFrame({"a": [True]}, index=["X"])
        out = score_candidates(flags, {"a": {"lift": 1.05, "support": 100}})
        assert out.empty

    def test_no_flags_no_candidates(self):
        assert score_candidates(pd.DataFrame(), self._lifts()).empty

    def test_freshness_gate_drops_chronically_active(self):
        flags = pd.DataFrame({"a": [True, True], "b": [True, False]}, index=["FRESH", "STALE"])
        # STALE had 'a' active 5 sessions ago too; FRESH newly activated 'b'
        prev = pd.DataFrame({"a": [True, True], "b": [False, False]}, index=["FRESH", "STALE"])
        out = score_candidates(flags, self._lifts(), prev_flags=prev)
        assert list(out["symbol"]) == ["FRESH"]

    def test_freshness_gate_handles_new_symbol(self):
        flags = pd.DataFrame({"a": [True]}, index=["NEWLIST"])
        prev = pd.DataFrame({"a": []}, index=pd.Index([], dtype=object))
        out = score_candidates(flags, self._lifts(), prev_flags=prev)
        # absent from prev == not previously active == fresh
        assert list(out["symbol"]) == ["NEWLIST"]

    def test_no_prev_flags_keeps_old_behaviour(self):
        flags = pd.DataFrame({"a": [True]}, index=["X"])
        assert not score_candidates(flags, self._lifts()).empty
