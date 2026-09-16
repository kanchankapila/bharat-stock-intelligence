"""feature_store's fundamentals/flow inputs come from DEEP history tables (AF-20260913-02).

The previous sources (fundamentals_history from 2026-06-30, technical_signals' live flow
columns) only exist for the last few months, so a symbol's first ~5 years of DL training rows
held 0 for these inputs and real values appeared only at the end -- a feature whose meaning
changes mid-panel. Each input now comes from one source for every date, point-in-time:
quarterly data is usable only from period_end + DEEP_QUARTERLY_LAG_DAYS.
"""
import os
import re
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
fe_mod = pytest.importorskip("feature_engineering")

LAG = fe_mod.DEEP_QUARTERLY_LAG_DAYS
IDX = pd.bdate_range("2024-01-01", "2025-12-31", name="date")


def _tables():
    closes = pd.DataFrame({"date": IDX, "close": 100.0})
    eps = pd.DataFrame({"date": pd.to_datetime(["2024-03-31", "2025-03-31"]), "eps_ttm": [5.0, 4.0]})
    dal = pd.DataFrame({
        "period_end": pd.to_datetime(["2024-03-31", "2024-06-30", "2025-03-31", "2025-06-30"]),
        "eps": [2.0, -1.0, 3.0, 1.0],
        "yoy_revenue_growth": [0.10, 0.20, 0.30, 0.40],
    })
    deliv = pd.DataFrame({"date": IDX[IDX != pd.Timestamp("2024-06-03")], "deliv_pct": 55.0})
    pb = pd.DataFrame({"date": IDX, "pb_ratio": 2.5})
    trades = pd.DataFrame([{"acquirerName": "p", "typeOfTransaction": "Market Sale",
                            "quantity": 10, "date_iso": "2025-02-03"}])
    return {"stock_ohlcv": closes, "trendlyne_eps_history": eps,
            "dalalos_financial_trends_history": dal, "nse_universe_history": deliv,
            "trendlyne_pb_history": pb, "insider_trades": trades}


@pytest.fixture
def deep(monkeypatch):
    tables = _tables()

    def fake_read_df(sql, params=()):
        m = re.search(r"FROM\s+(\w+)", sql)
        name = m.group(1) if m else None
        if name not in tables:
            raise AssertionError(f"unexpected read: {sql[:80]}")
        return tables[name].copy()

    monkeypatch.setattr(fe_mod, "read_df", fake_read_df)
    feat = pd.DataFrame(index=IDX)
    for c in ("trailing_pe", "earnings_yield", "price_to_book", "rev_growth", "eps_growth",
              "delivery_pct", "insider_buy_pct_90d"):
        feat[c] = 999.0  # a stale value from a shallow source must not survive
    return fe_mod.FeatureEngineer()._merge_deep_history(feat, "SYN")


def test_lag_covers_the_sebi_results_window():
    # literal, not derived: SEBI allows 45 days after a quarter (60 after Q4)
    assert fe_mod.DEEP_QUARTERLY_LAG_DAYS >= 60


def test_quarterly_values_invisible_until_period_end_plus_lag(deep):
    # Q ending 2024-03-31 must stay invisible through mid-May, when results are still pending.
    assert deep.loc["2024-04-01":"2024-05-15", "trailing_pe"].isna().all()
    assert deep.loc["2024-04-01":"2024-05-15", "rev_growth"].isna().all()
    avail = pd.Timestamp("2024-03-31") + pd.Timedelta(days=LAG)
    first = deep.loc[deep.index >= avail].iloc[0]
    assert first["trailing_pe"] == pytest.approx(20.0)        # 100 / 5
    assert first["earnings_yield"] == pytest.approx(0.05)     # 5 / 100, decimal like ey/100
    assert first["rev_growth"] == pytest.approx(0.10)


def test_eps_growth_is_same_quarter_last_year_with_abs_denominator(deep):
    assert np.isnan(deep.loc["2025-05-01", "eps_growth"]), "Q1-2025 growth visible before results"
    q1 = deep.loc[pd.Timestamp("2025-03-31") + pd.Timedelta(days=LAG):].iloc[0]
    assert q1["eps_growth"] == pytest.approx((3.0 - 2.0) / 2.0)
    assert deep.loc["2025-08-01", "eps_growth"] == pytest.approx(0.5), "Q2-2025 growth visible early"
    q2 = deep.loc[pd.Timestamp("2025-06-30") + pd.Timedelta(days=LAG):].iloc[0]
    assert q2["eps_growth"] == pytest.approx((1.0 - -1.0) / 1.0)
    assert deep.loc["2024-12-02", "eps_growth"] != deep.loc["2024-12-02", "eps_growth"], \
        "no prior-year quarter yet -> NaN, not a fabricated growth"


def test_daily_sources_are_not_forward_filled_across_gaps(deep):
    assert np.isnan(deep.loc["2024-06-03", "delivery_pct"])
    assert deep.loc["2024-06-04", "delivery_pct"] == 55.0
    assert (deep["price_to_book"] == 2.5).all()


def test_insider_is_point_in_time_and_neutral_without_trades(deep):
    assert deep.loc["2025-01-06", "insider_buy_pct_90d"] == 0.5
    assert deep.loc["2025-02-14", "insider_buy_pct_90d"] == 0.0
    assert deep.loc["2025-12-01", "insider_buy_pct_90d"] == 0.5


def test_no_stale_shallow_value_survives(deep):
    assert not (deep == 999.0).any().any()
