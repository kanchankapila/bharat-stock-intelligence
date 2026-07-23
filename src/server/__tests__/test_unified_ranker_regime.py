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
