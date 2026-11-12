"""sizing_shadow_arm: does sizing the frozen paper book by a breakout-adjusted volatility forecast lower its risk
(AF-20261111-02)? Each test pins one rule that would make the comparison dishonest if it broke."""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import paper_book as P
import sizing_shadow_arm as S

SESS = pd.bdate_range("2026-01-05", periods=8)
P2 = dict(book_size=2, enter_top_pct=0.5, keep_top_pct=0.5, max_hold_sessions=21, min_adt=1.0, cost_per_side=0.001)


def _world():
    O = pd.DataFrame({"A": [100, 100, 110, 99, 99, 105], "B": [100, 100, 95, 95, 100, 100],
                      "C": [100, 100, 100, 104, 104, 104], "D": [100, 100, 100, 100, 100, 100]}, index=SESS[:6])
    ADT = pd.DataFrame(10.0, index=O.index, columns=O.columns)
    calls = {SESS[0]: pd.Series({"A": 4, "B": 3, "C": 2, "D": 1}),
             SESS[2]: pd.Series({"A": 1, "B": 4, "C": 3, "D": 2})}
    return O, ADT, calls


def test_paper_book_exposes_positions_without_changing_its_output():
    O, ADT, calls = _world()
    D = P.simulate(calls, O, ADT, P2)
    assert len(D.attrs["positions"]) == len(D)
    assert D.attrs["positions"][0] == ["A", "B"]


def test_equal_arm_reproduces_the_frozen_paper_book_net_exactly():
    # The control: with no sigma the shadow's accounting must be the paper book's, cost included.
    O, ADT, calls = _world()
    D = P.simulate(calls, O, ADT, P2)
    net = S.arm_returns(D, O, None, P2["book_size"], P2["cost_per_side"])
    assert np.allclose(net.values, D["net"].values)


def test_inverse_sigma_weights_keep_equal_weight_gross_and_favour_calm_names():
    w = S.weights(["A", "B"], pd.Series({"A": 0.01, "B": 0.02}), K=4)
    assert w.sum() == pytest.approx(2 / 4)
    assert w["A"] == pytest.approx(2 * w["B"])


def test_a_name_without_a_forecast_takes_the_median_sigma_not_zero_or_infinite_weight():
    w = S.weights(["A", "B", "C"], pd.Series({"A": 0.01, "B": 0.03, "C": np.nan}), K=3)
    assert w.sum() == pytest.approx(1.0)
    assert w["C"] == pytest.approx((1 / 0.02) / (1 / 0.01 + 1 / 0.03 + 1 / 0.02))


def test_breakout_raises_the_forecast_at_equal_trailing_volatility():
    p = S.PROTOCOL
    lo, hi = S.sigma_breakout(0.02, 0.1, p), S.sigma_breakout(0.02, 0.9, p)
    assert hi > lo


def test_resizing_between_sessions_is_charged_even_with_no_entry_or_exit():
    O, ADT, calls = _world()
    D = P.simulate({SESS[0]: calls[SESS[0]]}, O, ADT, P2)          # A, B held throughout, no later trades
    sig = {SESS[0]: pd.Series({"A": 0.01, "B": 0.02}), SESS[1]: pd.Series({"A": 0.02, "B": 0.01})}
    net = S.arm_returns(D, O, sig, P2["book_size"], P2["cost_per_side"])
    w0, w1 = S.weights(["A", "B"], sig[SESS[0]], 2), S.weights(["A", "B"], sig[SESS[1]], 2)
    gross1 = (w1 * (O.iloc[3][["A", "B"]] / O.iloc[2][["A", "B"]] - 1)).sum()
    assert net.iloc[1] == pytest.approx(gross1 - 0.001 * (w1 - w0).abs().sum())


def test_verdict_is_low_data_before_the_minimum_and_needs_both_lower_variance_and_no_worse_sharpe():
    rng = np.random.default_rng(0)
    base = pd.Series(rng.normal(0.001, 0.01, 80))
    calm = base * 0.6
    assert S.verdict(base[:30], calm[:30], 60)["status"] == "LOW-DATA"
    assert S.verdict(base, calm, 60)["status"] == "PASS"
    assert S.verdict(base, base * 1.4, 60)["status"] == "FAIL"
