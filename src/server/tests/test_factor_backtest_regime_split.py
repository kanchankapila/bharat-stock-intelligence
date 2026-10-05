"""AF-20261003-08 (experiments 1/3/6/8): condition a factor_backtest result on the market regime.

The stored `market_regimes` labels are NOT usable for a historical split: 681 of 729 rows were written
by one backfill on 2026-08-09 from an HMM fitted on the whole history, so a label for 2024-03 was
produced with 2026 data. The split therefore uses a rule-based regime from the Nifty close series that
uses only data on or before each date. Rebalance periods are disjoint, so per-regime means are independent."""
import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import factor_backtest as fb


def _series(values, start="2022-01-03"):
    idx = pd.bdate_range(start, periods=len(values))
    return pd.Series(np.asarray(values, dtype=float), index=idx)


def test_uptrend_is_labelled_up_and_downtrend_down():
    up = fb.pit_regimes(_series(np.linspace(100, 200, 500)))
    down = fb.pit_regimes(_series(np.linspace(200, 100, 500)))
    assert up.dropna().iloc[-1].startswith("UP")
    assert down.dropna().iloc[-1].startswith("DOWN")


def test_warmup_dates_have_no_label_instead_of_a_guess():
    labels = fb.pit_regimes(_series(np.linspace(100, 150, 400)))
    assert labels.iloc[:199].isna().all()


def test_labels_never_use_future_data():
    rng = np.random.default_rng(7)
    full = _series(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, 700))))
    cut = 450
    a = fb.pit_regimes(full)
    b = fb.pit_regimes(full.iloc[:cut])
    pd.testing.assert_series_equal(a.iloc[:cut], b, check_names=False)


def _periods(n, excess_by_i):
    dates = pd.bdate_range("2023-01-02", periods=n * 21)[::21][:n]
    uni = np.zeros(n)
    net = np.array([excess_by_i(i) for i in range(n)], dtype=float)
    return pd.DataFrame({"date": dates, "net_pct": net, "universe_pct": uni})


def test_breakdown_groups_excess_by_regime_at_the_rebalance_date():
    n = 20
    per = _periods(n, lambda i: 2.0 if i % 2 == 0 else -1.0)
    labels = pd.Series(["UP-LV" if i % 2 == 0 else "DOWN-HV" for i in range(n)],
                       index=pd.DatetimeIndex(per["date"]))
    out = {r["regime"]: r for r in fb.regime_breakdown(per, labels, min_periods=5)}
    assert out["UP-LV"]["periods"] == 10 and out["UP-LV"]["mean_excess_pct"] == 2.0
    assert out["DOWN-HV"]["periods"] == 10 and out["DOWN-HV"]["mean_excess_pct"] == -1.0
    assert out["UP-LV"]["pct_beating"] == 100.0 and out["DOWN-HV"]["pct_beating"] == 0.0


def test_breakdown_flags_thin_regimes_as_low_data_not_as_evidence():
    per = _periods(10, lambda i: 1.0 + i)
    labels = pd.Series(["A"] * 3 + ["B"] * 7, index=pd.DatetimeIndex(per["date"]))
    out = {r["regime"]: r for r in fb.regime_breakdown(per, labels, min_periods=5)}
    assert out["A"]["verdict"] == "LOW-DATA" and out["B"]["verdict"] != "LOW-DATA"


def test_breakdown_drops_periods_with_no_label_and_says_how_many():
    per = _periods(6, lambda i: 1.0)
    labels = pd.Series([None, None, "A", "A", "A", "A"], index=pd.DatetimeIndex(per["date"]))
    out = fb.regime_breakdown(per, labels, min_periods=2)
    assert sum(r["periods"] for r in out if r["regime"] != "(unlabelled)") == 4
    assert [r for r in out if r["regime"] == "(unlabelled)"][0]["periods"] == 2
