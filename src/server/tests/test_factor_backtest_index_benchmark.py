"""A second, BUYABLE benchmark for factor_backtest (2026-10-27).

The harness judged every factor only against the equal-weight >= Rs1cr universe mean (~19%/yr,
pulled up by a right tail of small caps nobody can hold equal-weighted). That answers "is it
skill", not "does it beat an index fund". Each period is now also compared with a price index
(NIFTY500, price-only like the strategy leg) over the same rebalance-to-rebalance window."""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import factor_backtest as fb


def _close(pairs):
    return pd.Series([p for _, p in pairs], index=pd.DatetimeIndex([d for d, _ in pairs]))


def _periods(rows):
    return pd.DataFrame(rows, columns=["date", "exit_date", "net_pct"])


def test_excess_is_net_minus_the_index_move_over_the_same_window():
    idx = _close([("2024-01-01", 100.0), ("2024-02-01", 110.0), ("2024-03-01", 99.0)])
    p = _periods([("2024-01-01", "2024-02-01", 5.0), ("2024-02-01", "2024-03-01", -5.0)])
    b = fb.index_benchmark(p, idx, "NIFTY500", rebalance_days=21)
    assert b["index_per_period_pct"] == pytest.approx((10.0 - 10.0) / 2)
    assert b["net_excess_vs_index_pct"] == pytest.approx(((5 - 10) + (-5 + 10)) / 2)
    assert b["index_max_drawdown_pct"] == pytest.approx(-10.0)
    assert b["index_name"] == "NIFTY500"


def test_a_date_missing_from_the_index_uses_the_last_close_before_it_never_a_later_one():
    idx = _close([("2024-01-01", 100.0), ("2024-01-31", 120.0), ("2024-02-05", 500.0)])
    p = _periods([("2024-01-01", "2024-02-02", 0.0)])   # 2024-02-02 absent: 2024-01-31 applies
    b = fb.index_benchmark(p, idx, "NIFTY500", rebalance_days=21)
    assert b["index_per_period_pct"] == pytest.approx(20.0)


def test_periods_before_the_index_starts_are_dropped_not_scored_as_zero():
    idx = _close([("2024-02-01", 100.0), ("2024-03-01", 110.0)])
    p = _periods([("2024-01-01", "2024-02-01", 50.0), ("2024-02-01", "2024-03-01", 10.0)])
    b = fb.index_benchmark(p, idx, "NIFTY500", rebalance_days=21)
    assert b["index_periods"] == 1
    assert b["net_excess_vs_index_pct"] == pytest.approx(0.0)


def test_run_backtest_periods_carry_their_exit_date():
    rows = []
    for sym in ("A", "B", "C", "D"):                      # selection needs >= 2 x top_k names
        for i, d in enumerate(["2026-01-01", "2026-01-02", "2026-01-03"]):
            rows.append(dict(symbol=sym, date=d, adt20=1e9, next_open=100.0 * 1.1 ** (i + 1),
                             r21=1.0, deliv_pct=50.0))
    px = pd.DataFrame(rows)
    px["signal_eligible"] = True
    px["eligible"] = True
    r = fb.run_backtest(px, "delivery_pct", rebalance_days=1, top_k=2, cost_bps_per_side=0.0)
    df = r["_periods_df"]
    assert list(df["exit_date"]) == ["2026-01-02", "2026-01-03"][: len(df)]
    assert (pd.to_datetime(df["exit_date"]) > pd.to_datetime(df["date"])).all()
