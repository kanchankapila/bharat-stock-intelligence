"""
Tests for regime-conditional category weights + red-flag hard veto in unified_ranker.

- regime_cat_weights(regime): tilts CAT_BASE_WT per market regime (value/quality up &
  breakout/momentum down in BEAR/CRASH; breakout/momentum up in BULL; SIDEWAYS neutral).
- is_red_flagged / veto_classification: a stock in a bearish Risk-Red-Flag screener cannot
  be a Buy regardless of its technical score.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from unified_ranker import (
    CAT_BASE_WT,
    REGIME_WEIGHTS,
    regime_cat_weights,
    is_red_flagged,
    veto_classification,
    compute_screener_stock_scores,
)


class TestRegimeCatWeights:
    def test_bear_tilts_value_up_breakout_down(self):
        w = regime_cat_weights("BEAR")
        assert w["valuation"] > CAT_BASE_WT["valuation"]
        assert w["fundamental_quality"] > CAT_BASE_WT["fundamental_quality"]
        assert w["technical_breakout"] < CAT_BASE_WT["technical_breakout"]
        assert w["technical_momentum"] < CAT_BASE_WT["technical_momentum"]

    def test_crash_is_more_defensive_than_bear(self):
        bear = regime_cat_weights("BEAR")
        crash = regime_cat_weights("CRASH")
        assert crash["valuation"] >= bear["valuation"]
        assert crash["technical_breakout"] <= bear["technical_breakout"]

    def test_bull_tilts_breakout_up(self):
        w = regime_cat_weights("BULL")
        assert w["technical_breakout"] > CAT_BASE_WT["technical_breakout"]
        assert w["technical_momentum"] > CAT_BASE_WT["technical_momentum"]

    def test_sideways_is_neutral(self):
        assert regime_cat_weights("SIDEWAYS") == CAT_BASE_WT

    def test_unknown_regime_is_neutral(self):
        assert regime_cat_weights("NONSENSE") == CAT_BASE_WT

    def test_returns_a_copy_not_mutating_base(self):
        before = dict(CAT_BASE_WT)
        regime_cat_weights("BEAR")["valuation"] = 999.0
        assert CAT_BASE_WT == before


class TestRegimeWeightsHasSideways:
    def test_sideways_present(self):
        assert "SIDEWAYS" in REGIME_WEIGHTS
        assert set(REGIME_WEIGHTS["SIDEWAYS"]) == {"screener", "ml", "cs", "confluence", "technical", "dl", "breakout"}


class TestComputeScoresWithRegimeWeights:
    def _membership(self):
        # One value-heavy name, one breakout-heavy name.
        return {
            "VALUE": [{"signal_bias": "bullish", "confidence": 0.8, "category": "valuation",
                       "subcategory": "", "investment_horizon": "long_term"}],
            "MOMO":  [{"signal_bias": "bullish", "confidence": 0.8, "category": "technical_breakout",
                       "subcategory": "", "investment_horizon": "swing"}],
        }

    def test_bear_weights_favor_value_over_breakout(self):
        m = self._membership()
        scores, _, _ = compute_screener_stock_scores(m, {}, cat_weights=regime_cat_weights("BEAR"))
        # In BEAR, the value name should out-rank the breakout name.
        assert scores["VALUE"] > scores["MOMO"]

    def test_default_weights_unchanged_when_omitted(self):
        m = self._membership()
        a, _, _ = compute_screener_stock_scores(m, {})
        b, _, _ = compute_screener_stock_scores(m, {}, cat_weights=CAT_BASE_WT)
        assert a == b


class TestRedFlagVeto:
    def test_flagged_on_bearish_risk_red_flag(self):
        screeners = [{"signal_bias": "bearish", "category": "risk_red_flags"}]
        assert is_red_flagged(screeners) is True

    def test_not_flagged_without_risk_category(self):
        screeners = [{"signal_bias": "bearish", "category": "valuation"},
                     {"signal_bias": "bullish", "category": "technical_breakout"}]
        assert is_red_flagged(screeners) is False

    def test_bullish_risk_flag_not_a_veto(self):
        # e.g. "pledge reduced" — a positive risk-category event must not veto.
        screeners = [{"signal_bias": "bullish", "category": "risk_red_flags"}]
        assert is_red_flagged(screeners) is False

    def test_empty_membership_not_flagged(self):
        assert is_red_flagged([]) is False

    def test_veto_demotes_buys_to_hold(self):
        assert veto_classification("Strong Buy") == "Hold"
        assert veto_classification("Buy") == "Hold"

    def test_veto_leaves_non_buys_unchanged(self):
        assert veto_classification("Hold") == "Hold"
        assert veto_classification("Sell") == "Sell"
        assert veto_classification("Strong Sell") == "Strong Sell"


class TestTiltShrinkage:
    """Finding #31 (resolved 2026-07-31). REGIME_CAT_TILT is hand-set intuition that cannot be
    fitted OR sign-validated: BULL/CRASH carry the most extreme multipliers (0.30, 1.50) while
    having ZERO days of stock_factor_breakdown_history and only 3 and 6 lifetime regime
    episodes. So the tilts are treated as priors and shrunk halfway toward neutral -- direction
    preserved, unjustifiable magnitude damped."""

    def test_shrink_pulls_toward_neutral_and_keeps_sign(self):
        from unified_ranker import shrink_tilt
        assert shrink_tilt(0.30, 0.5) == pytest.approx(0.65)   # 70% cut -> 35% cut
        assert shrink_tilt(1.50, 0.5) == pytest.approx(1.25)
        assert shrink_tilt(1.0, 0.5) == pytest.approx(1.0)     # neutral stays neutral

    def test_shrinkage_bounds(self):
        from unified_ranker import shrink_tilt
        assert shrink_tilt(0.30, 0.0) == pytest.approx(1.0)    # fully neutral
        assert shrink_tilt(0.30, 1.0) == pytest.approx(0.30)   # raw hand-set value

    def test_direction_of_every_hand_set_tilt_is_preserved(self):
        """Shrinkage must never flip a tilt across neutral -- that would silently invert an
        economically-motivated call (e.g. 'underweight breakout in a crash')."""
        from unified_ranker import REGIME_CAT_TILT, shrink_tilt
        for regime, tilt in REGIME_CAT_TILT.items():
            for cat, raw in tilt.items():
                got = shrink_tilt(raw)
                if raw > 1.0:
                    assert got > 1.0, f"{regime}/{cat} flipped below neutral"
                elif raw < 1.0:
                    assert got < 1.0, f"{regime}/{cat} flipped above neutral"
                assert min(raw, 1.0) <= got <= max(raw, 1.0), f"{regime}/{cat} outside bounds"

    def test_applied_weights_are_shrunk_not_raw(self):
        from unified_ranker import CAT_BASE_WT, REGIME_CAT_TILT, regime_cat_weights, shrink_tilt
        crash = regime_cat_weights("CRASH")
        raw_mult = REGIME_CAT_TILT["CRASH"]["technical_breakout"]
        base = CAT_BASE_WT["technical_breakout"]
        assert crash["technical_breakout"] == pytest.approx(base * shrink_tilt(raw_mult))
        assert crash["technical_breakout"] != pytest.approx(base * raw_mult), \
            "raw hand-set multiplier is being applied at full strength"

    def test_a_fitted_override_is_applied_unshrunk(self):
        """Shrinkage damps unvalidated intuition. A tilt actually fitted from outcomes is not
        that, so it must win at full strength."""
        import unified_ranker as ur
        saved = ur._regime_tilt_override
        try:
            ur._regime_tilt_override = {"BEAR": {"valuation": 2.0}}
            w = ur.regime_cat_weights("BEAR")
            assert w["valuation"] == pytest.approx(ur.CAT_BASE_WT["valuation"] * 2.0)
        finally:
            ur._regime_tilt_override = saved

    def test_readiness_reports_not_ready_on_thin_history(self):
        """The gate that lets Finding #31 unblock itself: a regime with almost no history must
        report ready_to_fit False, so nothing starts fitting on 13 days of data."""
        import sqlite3
        from unified_ranker import regime_tilt_fit_readiness
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE stock_factor_breakdown_history (regime TEXT, snapshot_date TEXT)")
        con.execute("CREATE TABLE market_regimes (date TEXT, regime TEXT)")
        con.executemany("INSERT INTO stock_factor_breakdown_history VALUES (?,?)",
                        [("BEAR", "2026-07-17")])
        con.executemany("INSERT INTO market_regimes VALUES (?,?)",
                        [("2026-07-17", "BEAR"), ("2026-07-18", "BULL")])
        con.commit()
        out = regime_tilt_fit_readiness(con)
        assert out["BEAR"]["ready_to_fit"] is False
        assert out["BEAR"]["factor_history_days"] == 1
        assert out["BULL"]["factor_history_days"] == 0
