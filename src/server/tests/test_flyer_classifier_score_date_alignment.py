"""
Regression test for flyer_classifier.score()'s write-target date (found 2026-08-19 tracing
the model's negative IC end-to-end -- unrelated to that finding, but caught along the way).

The model is trained on features(feat_date) -> label(flew on the trading day AFTER feat_date)
-- see load_labeled_features's feat_date = prev_trading_day(label date). So a prediction made
from the latest available session's close (`d`) describes the FOLLOWING session, not `d`
itself. score() used to write under `d`, mislabeling every live-scored row by one trading day.
Same "write-target date" bug class as test_bse_event_classifier_run_daily.py.
"""
import os
import pickle
import sqlite3
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

import flyer_classifier as fc  # noqa: E402


class _FakeModel:
    """predict_proba returning a fixed P(flyer)=0.7 for every row, 2-class shape."""
    def predict_proba(self, X):
        n = len(X)
        return np.column_stack([np.full(n, 0.3), np.full(n, 0.7)])


def _make_conn():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, flyer_probability REAL, PRIMARY KEY (symbol, date)
        )
    """)
    return conn


def _write_fake_model(tmp_path, monkeypatch):
    model_path = tmp_path / "flyer.pkl"
    with open(model_path, "wb") as f:
        pickle.dump({"models": [_FakeModel()], "feature_names": ["f1"]}, f)
    monkeypatch.setattr(fc, "MODEL_PATH", str(model_path))


def _patch_pipeline(monkeypatch, conn, feature_date: str):
    monkeypatch.setattr(fc, "connect", lambda: conn)
    monkeypatch.setattr(fc, "_load_ohlcv", lambda cutoff: pd.DataFrame({
        "symbol": ["RELIANCE"], "date": [feature_date], "close": [100.0], "volume": [1000.0],
    }))
    monkeypatch.setattr(fc, "compute_ohlcv_features", lambda ohlcv: pd.DataFrame({
        "symbol": ["RELIANCE"], "date": [feature_date], "f1": [0.5],
    }))


def test_score_writes_to_the_session_AFTER_the_feature_date_not_the_feature_date_itself(monkeypatch, tmp_path):
    conn = _make_conn()
    # The session the features come from (D) already has a row (written earlier that day),
    # and the NEXT session (D+1) already has a row too (created by the morning scan) -- the
    # scenario score() is meant to write into.
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES ('RELIANCE', '2026-08-14')")
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES ('RELIANCE', '2026-08-17')")
    conn.commit()
    _write_fake_model(tmp_path, monkeypatch)
    _patch_pipeline(monkeypatch, conn, feature_date="2026-08-14")  # a Friday; next row is 2026-08-17 (Mon)

    n = fc.score()

    assert n == 1
    written = conn.execute(
        "SELECT flyer_probability FROM technical_signals WHERE symbol='RELIANCE' AND date='2026-08-17'"
    ).fetchone()
    assert written["flyer_probability"] == 0.7

    # Negative control lives in this same assertion: the pre-fix code wrote under the feature
    # date itself (2026-08-14), which must be untouched by the fix.
    untouched = conn.execute(
        "SELECT flyer_probability FROM technical_signals WHERE symbol='RELIANCE' AND date='2026-08-14'"
    ).fetchone()
    assert untouched["flyer_probability"] is None


def test_score_skips_rather_than_silently_misdating_when_the_next_session_has_no_row_yet(monkeypatch, tmp_path):
    """If tomorrow's technical_signals row doesn't exist yet (score() run before the morning
    scan creates it), there is nothing correct to write to -- must skip, not fall back to
    writing under the feature date (which is exactly the bug being fixed)."""
    conn = _make_conn()
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES ('RELIANCE', '2026-08-14')")
    conn.commit()
    _write_fake_model(tmp_path, monkeypatch)
    _patch_pipeline(monkeypatch, conn, feature_date="2026-08-14")

    n = fc.score()

    assert n == 0
    row = conn.execute(
        "SELECT flyer_probability FROM technical_signals WHERE symbol='RELIANCE' AND date='2026-08-14'"
    ).fetchone()
    assert row["flyer_probability"] is None
