"""
Tests for pcr_fetcher.parse_niftytrader_chain — the pure parser that turns a
NiftyTrader option-chain `resultData` payload into our stock_options_oi row dict.

NiftyTrader's default (empty expiryDate) call returns ONLY the nearest expiry,
so near-expiry OI == total OI. Equity IV (`calls_iv`/`puts_iv`) is 0.0 there, so
atm_iv/iv_skew must come back None (vendor limit — index-only IV).
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pcr_fetcher import parse_niftytrader_chain


def _row(strike, c_oi, p_oi, c_vol=0, p_vol=0, c_iv=0.0, p_iv=0.0, spot=100.0):
    return {
        "strike_price": strike,
        "calls_oi": c_oi, "puts_oi": p_oi,
        "calls_volume": c_vol, "puts_volume": p_vol,
        "calls_iv": c_iv, "puts_iv": p_iv,
        "index_close": spot,
        "expiry_date": "2026-06-30T00:00:00",
    }


class TestParseNiftytraderChain:
    def test_empty_chain_returns_none(self):
        assert parse_niftytrader_chain({"opDatas": []}, "RELIANCE") is None
        assert parse_niftytrader_chain({}, "RELIANCE") is None

    def test_aggregates_oi_and_pcr(self):
        oc = [_row(90, 100, 300), _row(100, 200, 100), _row(110, 50, 50)]
        out = parse_niftytrader_chain({"opDatas": oc}, "RELIANCE")
        assert out["symbol"] == "RELIANCE"
        assert out["call_oi"] == 350          # 100+200+50
        assert out["put_oi"] == 450           # 300+100+50
        assert out["total_call_oi"] == 350    # single expiry → near == total
        assert out["total_put_oi"] == 450
        assert out["pcr"] == pytest.approx(450 / 350)
        assert out["market_pcr"] == pytest.approx(450 / 350)

    def test_volume_pcr(self):
        oc = [_row(100, 10, 10, c_vol=200, p_vol=100)]
        out = parse_niftytrader_chain({"opDatas": oc}, "X")
        assert out["pcr_vol"] == pytest.approx(100 / 200)

    def test_pcr_none_when_no_call_oi(self):
        oc = [_row(100, 0, 50)]
        out = parse_niftytrader_chain({"opDatas": oc}, "X")
        assert out["pcr"] is None

    def test_equity_iv_zero_yields_none(self):
        # NiftyTrader returns 0.0 IV for equities → atm_iv/iv_skew must be None, not 0.
        oc = [_row(95, 10, 10), _row(100, 10, 10), _row(105, 10, 10)]
        out = parse_niftytrader_chain({"opDatas": oc}, "X")
        assert out["atm_iv"] is None
        assert out["iv_skew"] is None

    def test_iv_computed_when_present(self):
        # If a future/index payload DOES carry IV, it must flow through (spot=100).
        oc = [_row(95, 10, 10, c_iv=17, p_iv=24, spot=100),
              _row(100, 10, 10, c_iv=18, p_iv=20, spot=100),
              _row(105, 10, 10, c_iv=15, p_iv=19, spot=100)]
        out = parse_niftytrader_chain({"opDatas": oc}, "X")
        assert out["atm_iv"] == pytest.approx((18 + 20) / 2)
        assert out["iv_skew"] == pytest.approx(24 - 15)

    def test_expiry_normalized_to_date(self):
        out = parse_niftytrader_chain({"opDatas": [_row(100, 10, 10)]}, "X")
        assert out["expiry"] == "2026-06-30"

    def test_uses_optionchain_key_fallback(self):
        out = parse_niftytrader_chain({"optionChain": [_row(100, 10, 10)]}, "X")
        assert out is not None and out["call_oi"] == 10
