"""Live DL inference must transform features exactly as training does.

feature_store held per-symbol RobustScaler output until 2026-09-10, so both loaders read
already-scaled columns. The rebuild made the store RAW and moved scaling into
load_symbol_sequences -- but load_inference_sequence was never given the same step. Measured
live 2026-09-12 on RELIANCE: median |input| 0.283 in training vs 0.874 at inference, max 58 vs
10,000 (the clip bound); sma200 0.949 vs 1,386, obv -2.48 vs -10,000. Every production dl_score
since the rebuild was a model trained on scaled inputs being fed raw prices.

Parity is asserted against the REAL training loader, not a re-implementation of it, so the two
cannot drift apart again without this failing.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
de = pytest.importorskip("dl_engine")

SEQ = 20


def _frame(n=260, target_tail_missing=15, seed=7):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2025-01-01", periods=n)
    cols = [c for c in de.FEATURE_COLS if c not in de._VOL_ONEHOT]
    data = {"date": dates.strftime("%Y-%m-%d")}
    for i, c in enumerate(cols):
        scale = 1300.0 if i % 3 == 0 else (5.0 if i % 3 == 1 else 0.02)
        data[c] = scale * (1 + 0.05 * rng.standard_normal(n)) + 0.001 * np.arange(n)
    data["vol_regime"] = rng.choice(["LOW", "MED", "HIGH"], n)
    ret = 0.01 * rng.standard_normal(n)
    data["target_ret_5d"] = ret
    data["target_ret_15d"] = ret
    df = pd.DataFrame(data)
    # the newest rows have no forward return yet -- exactly what inference scores
    df.loc[df.index[-target_tail_missing:], ["target_ret_5d", "target_ret_15d"]] = np.nan
    return df


@pytest.fixture
def patched(monkeypatch):
    frame = _frame()

    def fake_read_df(sql, params=()):
        df = frame.copy()
        if "ORDER BY date DESC" in sql:
            df = df.sort_values("date", ascending=False)
            import re
            m = re.search(r"LIMIT\s+(\d+)", sql)
            if m:
                df = df.head(int(m.group(1)))
        if "target_ret_5d" not in sql:
            df = df.drop(columns=["target_ret_5d", "target_ret_15d"])
        return df.reset_index(drop=True)

    monkeypatch.setattr(de, "read_df", fake_read_df)
    return frame


def _training_rows_by_date(symbol="SYN"):
    X, _, _, _, label_dates = de.load_symbol_sequences(symbol, seq_len=SEQ, n_features=de.N_FEATURES)
    frame = _frame()
    tgt_dates = frame.dropna(subset=["target_ret_5d", "target_ret_15d"])["date"].tolist()
    by_date = {}
    for k in range(len(X)):
        i = SEQ + k
        for step, d in enumerate(tgt_dates[i - SEQ:i]):
            by_date[d] = X[k, step]
    return by_date


def test_inference_inputs_are_scaled_like_training(patched):
    Xinf, last = de.load_inference_sequence("SYN", seq_len=SEQ, n_features=de.N_FEATURES)
    assert Xinf is not None
    # Raw columns sit near 1,300; a scaled matrix does not. This is the live RELIANCE failure.
    # A third of the fixture's columns sit near 1,300 raw; scaled, nothing comes close.
    assert np.abs(Xinf).max() < 100.0, f"inference fed raw magnitudes: max |x|={np.abs(Xinf).max():.1f}"


def test_inference_matches_training_transform_on_shared_dates(patched):
    by_date = _training_rows_by_date()
    frame = _frame()
    Xinf, last = de.load_inference_sequence("SYN", seq_len=SEQ, n_features=de.N_FEATURES)
    inf_dates = frame["date"].tolist()[-SEQ:]
    shared = [(s, d) for s, d in enumerate(inf_dates) if d in by_date]
    assert shared, "fixture must overlap training rows or the parity check is vacuous"
    for step, d in shared:
        np.testing.assert_allclose(Xinf[0, step], by_date[d], rtol=1e-5, atol=1e-5,
                                   err_msg=f"train/serve skew on {d}")


def test_inference_still_scores_the_newest_date(patched):
    frame = _frame()
    _, last = de.load_inference_sequence("SYN", seq_len=SEQ, n_features=de.N_FEATURES)
    assert str(last)[:10] == frame["date"].iloc[-1], "inference must end on the latest row, targets or not"
