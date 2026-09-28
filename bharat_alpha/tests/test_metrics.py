"""Harness correctness on constructed data with known answers (no DB)."""
import numpy as np
import pandas as pd
import pytest

from bharat_alpha.evaluation.metrics import (
    evaluate_scores, newey_west_t, per_date_ic, summarize_ic, tail_aucs, topk_excess,
)
from bharat_alpha.labels import winsorize_rows


def _panel(n_dates=200, n_names=100, ic=0.1, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2023-01-02", periods=n_dates)
    s = rng.normal(size=(n_dates, n_names))
    noise = rng.normal(size=(n_dates, n_names))
    f = ic * s + np.sqrt(1 - ic ** 2) * noise
    return pd.DataFrame(s, idx), pd.DataFrame(f * 0.05, idx)


def test_ic_recovers_planted_correlation_and_is_zero_for_noise():
    s, f = _panel(ic=0.15)
    assert per_date_ic(s, f).mean() == pytest.approx(0.15, abs=0.02)
    s0, f0 = _panel(ic=0.0, seed=1)
    assert abs(per_date_ic(s0, f0).mean()) < 0.02


def test_effective_dates_divide_by_horizon_and_gate_reliability():
    ic = pd.Series(np.full(60, 0.05))
    assert summarize_ic(ic, horizon=1).reliable
    s = summarize_ic(ic, horizon=5)
    assert s.eff_dates == 12 and not s.reliable      # 60 overlapping 5d windows ≈ 12 independent


def test_newey_west_shrinks_t_for_autocorrelated_series():
    rng = np.random.default_rng(0)
    e = rng.normal(size=2000)
    ar = pd.Series(e).rolling(10).mean().dropna().to_numpy() + 0.02   # overlapping-window structure
    naive = ar.mean() / (ar.std() / np.sqrt(len(ar)))
    assert abs(newey_west_t(ar, lags=9)) < abs(naive) / 2


def test_winsorize_actually_clips_a_lone_outlier():
    row = np.r_[np.zeros(99), 1279.0]                 # the +127,900% RELIANCE bar
    out = winsorize_rows(pd.DataFrame([row]), 0.01)
    assert out.to_numpy().max() == 0.0                 # linear interpolation would leave ~12.8


def test_median_beater_is_flagged():
    # scores pick low-variance names: beat the median, lose to a right-skewed mean
    idx = pd.bdate_range("2023-01-02", periods=30)
    rng = np.random.default_rng(3)
    s_rows, f_rows = [], []
    for _ in idx:
        lowvol = rng.normal(0.001, 0.001, 50)
        lottery = np.r_[rng.normal(-0.01, 0.002, 45), rng.normal(0.4, 0.05, 5)]
        f_rows.append(np.r_[lowvol, lottery])
        s_rows.append(np.r_[np.ones(50), np.zeros(50)] + rng.normal(0, 0.01, 100))
    s, f = pd.DataFrame(s_rows, idx), pd.DataFrame(f_rows, idx)
    tk = topk_excess(s, f, k=20)
    assert (tk["exc_median"] > 0).all() and (tk["exc_mean"] < 0).all()
    assert evaluate_scores(s, f, horizon=1, k=20)["median_beater"]


def test_tail_aucs_separate_direction_from_volatility():
    # a "volatility detector": score = |future return| → great winners AUC, but losers AUC too
    rng = np.random.default_rng(5)
    idx = pd.bdate_range("2023-01-02", periods=40)
    f = pd.DataFrame(rng.normal(size=(40, 200)), idx)
    s = f.abs()
    a = tail_aucs(s, f)
    assert a["auc_winners"] > 0.7 and a["auc_losers"] < 0.3 and abs(a["auc_win_vs_lose"] - 0.5) < 0.05
