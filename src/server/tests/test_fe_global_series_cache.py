"""FeatureEngineer's market-wide series are read once per process, not once per symbol.

_merge_fii / _merge_macro / _merge_market_context read the same 10 series (FII/DII flows, five
macro series, NIFTY50 closes, INDIAVIX, NIFTY50 PE, market breadth) for every one of ~2,426
symbols: 98ms of the 8 cheapest alone per symbol, measured 2026-09-11 -- ~24k identical queries
and ~5 CPU-minutes per dl-feature-refresh run.
"""
import numpy as np
import pandas as pd

import feature_engineering as fe


def _fake_read_df(calls):
    dates = pd.date_range("2026-01-01", periods=40, freq="B").strftime("%Y-%m-%d")

    def read_df(sql, params=()):
        calls.append((sql, tuple(params)))
        seed = abs(hash((sql, tuple(params)))) % 1000
        v = np.arange(40, dtype=float) + seed
        s = sql.lower()
        if "fii_dii_flow" in s:
            return pd.DataFrame({"date": dates, "fii_net": v, "dii_net": -v})
        if "ret_5d" in s:
            return pd.DataFrame({"date": dates, "ret_5d": v / 100})
        if " pe " in s or "index_valuation" in s:
            return pd.DataFrame({"date": dates, "pe": v})
        if "market_breadth" in s:
            return pd.DataFrame({"date": dates, "adv_decline_ratio": v / 10})
        return pd.DataFrame({"date": dates, "close": 100 + v})
    return read_df


def _merge_all(eng):
    feat = pd.DataFrame(index=pd.date_range("2026-01-10", periods=20, freq="B"))
    feat = eng._merge_fii(feat)
    feat = eng._merge_macro(feat)
    return eng._merge_market_context(feat)


def test_global_series_are_read_once_across_symbols(monkeypatch):
    calls = []
    monkeypatch.setattr(fe, "read_df", _fake_read_df(calls))
    fe.clear_global_series_cache()
    eng = fe.FeatureEngineer()

    first = _merge_all(eng)
    reads_for_one_symbol = len(calls)
    second = _merge_all(eng)

    assert reads_for_one_symbol == 10
    assert len(calls) == reads_for_one_symbol
    pd.testing.assert_frame_equal(first, second)


def test_cached_result_matches_an_uncached_read(monkeypatch):
    calls = []
    monkeypatch.setattr(fe, "read_df", _fake_read_df(calls))
    fe.clear_global_series_cache()
    cached_first = _merge_all(fe.FeatureEngineer())
    cached_again = _merge_all(fe.FeatureEngineer())
    fe.clear_global_series_cache()
    fresh = _merge_all(fe.FeatureEngineer())
    pd.testing.assert_frame_equal(cached_again, fresh)
    pd.testing.assert_frame_equal(cached_first, fresh)
