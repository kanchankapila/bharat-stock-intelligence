"""Rank hysteresis (`exit_rank`): enter the top-K, keep a holding until it leaves the top-`exit_rank`.

Without it every rebalance replaces any name that slips from rank K to K+1, which is the
turnover that killed win_probability (83.4% one-way) and mean_reversion_14 (89.6%).
"""
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import factor_backtest as fb  # noqa: E402

DATES = [f"2026-01-0{i}" for i in range(1, 8)]


def panel():
    """B and C swap rank 2/3 every session; A is always first. Prices flat, so only turnover moves."""
    rows = []
    for i, d in enumerate(DATES):
        scores = {"A": 10, "B": 9 if i % 2 == 0 else 8, "C": 8 if i % 2 == 0 else 9, "D": 5, "E": 4, "F": 3}
        for sym, s in scores.items():
            rows.append(dict(symbol=sym, date=d, adt20=1e9, next_open=100.0, r21=1.0, deliv_pct=float(s)))
    px = pd.DataFrame(rows)
    px["signal_eligible"] = True
    px["eligible"] = True
    return px


def _run(**kw):
    return fb.run_backtest(panel(), "delivery_pct", rebalance_days=1, top_k=2, cost_bps_per_side=25.0, **kw)


def test_default_churns_on_a_one_rank_swap():
    df = _run()["_periods_df"]
    assert list(df["turnover"].iloc[1:]) == pytest.approx([0.5] * (len(df) - 1))


def test_hysteresis_keeps_a_name_inside_the_exit_band():
    df = _run(exit_rank=3)["_periods_df"]
    assert df["turnover"].iloc[0] == pytest.approx(0.5)   # entry from cash is half a round trip
    assert list(df["turnover"].iloc[1:]) == pytest.approx([0.0] * (len(df) - 1))
    assert all(n == 2 for n in df["n_names"])


def test_hysteresis_still_exits_a_name_that_leaves_the_band():
    p = panel()
    p.loc[(p.symbol == "B") & (p.date >= DATES[2]), "deliv_pct"] = 1.0   # B falls to last
    r = fb.run_backtest(p, "delivery_pct", rebalance_days=1, top_k=2, cost_bps_per_side=0.0, exit_rank=3)
    assert r["_periods_df"]["turnover"].iloc[2] == pytest.approx(0.5)


def test_exit_rank_none_is_the_existing_construction():
    a, b = _run(), _run(exit_rank=None)
    pd.testing.assert_frame_equal(a["_periods_df"], b["_periods_df"])


@pytest.mark.parametrize("kw", [dict(exit_rank=1), dict(exit_rank=3, long_short=True)])
def test_invalid_combinations_refused(kw):
    with pytest.raises(ValueError):
        _run(**kw)
