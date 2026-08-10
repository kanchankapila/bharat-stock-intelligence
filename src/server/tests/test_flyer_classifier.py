"""
flyer_classifier.py builds its training label by vectorizing high_flyer_retrospective's
detect_flyers() across the whole date range (that function itself is a single-day,
O(n)-per-call helper — looping it over ~1400 trading days is too slow for training). The
one real risk in that vectorization is silent definitional drift: if the two disagree on
which (symbol, date) pairs are "flyers", the model trains on a target the live daily job
doesn't actually use. This test proves they agree, day by day, on synthetic data exercising
both trigger paths (return+volume threshold, and a fresh high) plus the not-enough-history
and not-yet-listed edge cases.

Also covers the anti-leak date-alignment helper (label date must map to the PRECEDING
trading day for feature lookup, never itself) — the exact leak class this codebase has been
bitten by repeatedly (see CLAUDE.md's Look-Ahead Bias section).
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from flyer_classifier import build_flyer_labels, _prev_trading_day_map
from high_flyer_retrospective import detect_flyers, MIN_BARS


def _make_synthetic_ohlcv(seed: int = 0, n_days: int = 90):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2026-01-01", periods=n_days).strftime("%Y-%m-%d").tolist()

    close = pd.DataFrame(index=dates)
    volume = pd.DataFrame(index=dates)

    # A: quiet random walk, never a flyer.
    close["A"] = 100 + np.cumsum(rng.normal(0, 0.3, n_days))
    volume["A"] = rng.integers(80_000, 120_000, n_days).astype(float)

    # B: quiet, then a deliberate +6% jump on day 70 with 2x average volume.
    b = 100 + np.cumsum(rng.normal(0, 0.3, n_days))
    b[70] = b[69] * 1.06
    close["B"] = b
    vb = rng.integers(80_000, 120_000, n_days).astype(float)
    vb[70] = vb[69:69].mean() if False else vb[50:69].mean() * 2.2
    volume["B"] = vb

    # C: gentle uptrend that sets a fresh high (relative to its own short history) on day 65,
    # with a positive same-day return — exercises the new-high branch independent of volume.
    c = 100 + np.linspace(0, 3, n_days) + rng.normal(0, 0.15, n_days)
    c[65] = c[:65].max() * 1.02
    close["C"] = c
    volume["C"] = rng.integers(80_000, 120_000, n_days).astype(float)

    # D: not listed until day 50 (NaN before) — must never flag before it has MIN_BARS
    # of real trading history, and must not crash the vectorized path on leading NaNs.
    d = np.full(n_days, np.nan)
    d[50:] = 100 + np.cumsum(rng.normal(0, 0.3, n_days - 50))
    close["D"] = d
    vd = np.full(n_days, np.nan)
    vd[50:] = rng.integers(80_000, 120_000, n_days - 50).astype(float)
    volume["D"] = vd

    return close, volume


def test_vectorized_labels_match_detect_flyers_day_by_day():
    close, volume = _make_synthetic_ohlcv()
    vectorized = build_flyer_labels(close, volume)
    vec_flew = vectorized[vectorized["flew"] == 1]

    checked_any_positive = False
    for day in close.index[MIN_BARS:]:
        ground_truth = set(detect_flyers(close, volume, day)["symbol"])
        got = set(vec_flew[vec_flew["date"] == day]["symbol"])
        assert got == ground_truth, f"mismatch on {day}: vectorized={got} detect_flyers={ground_truth}"
        checked_any_positive = checked_any_positive or bool(ground_truth)

    assert checked_any_positive, "synthetic data produced zero flyer days — test isn't exercising the label logic"


def test_late_listing_never_flags_before_min_bars():
    """Symbol D has no history before day 50; it must never appear as a flyer until it has
    accumulated MIN_BARS (60) real trading days, i.e. not before day 50+60=110 (out of range
    for this 90-day fixture) — so D should never appear as a flyer at all here."""
    close, volume = _make_synthetic_ohlcv()
    vectorized = build_flyer_labels(close, volume)
    assert not ((vectorized["symbol"] == "D") & (vectorized["flew"] == 1)).any()


def test_prev_trading_day_map_never_maps_a_date_to_itself_or_a_later_date():
    dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"]
    m = _prev_trading_day_map(dates)
    assert m == {"2026-01-05": "2026-01-02", "2026-01-06": "2026-01-05", "2026-01-07": "2026-01-06"}
    assert "2026-01-02" not in m  # earliest date has no predecessor — must be excluded, not self-mapped
    for k, v in m.items():
        assert v < k