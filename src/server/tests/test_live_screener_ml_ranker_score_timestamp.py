"""live_screener_ml_scores.computed_at is a timestamptz column. score() wrote
datetime.now().isoformat() -- a NAIVE string in the host's local time (IST) -- which Postgres
read as UTC, so every score row sat 5.5h in the future (2026-09-28 .. 2026-10-05 measured: avg
+5.55h after its own run). A future-dated timestamp also makes the 'live-screener-ml-scores-freshness'
check read fresh for 5.5h after the writer has actually stopped."""
import datetime
import os
import pickle
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_screener_ml_ranker as lsmr


class _FixedProba:
    def predict_proba(self, X):
        return np.tile([0.4, 0.6], (len(X), 1))


def test_score_stamps_computed_at_as_timezone_aware_utc(monkeypatch, tmp_path):
    model_path = tmp_path / "model.pkl"
    with open(model_path, "wb") as f:
        pickle.dump({"model": _FixedProba(), "feature_names": ["change_per", "volume"],
                     "trained_at": "2026-10-01T00:00:00"}, f)
    monkeypatch.setattr(lsmr, "MODEL_PATH", str(model_path))
    monkeypatch.setattr(lsmr, "query_one", lambda *a, **k: (7, "2026-10-05 09:00:00+00"))
    monkeypatch.setattr(lsmr, "read_df", lambda *a, **k: pd.DataFrame(
        {"symbol": ["AAA", "BBB"], "filter_key": ["gain5", "gain5"],
         "change_per": [5.1, 6.2], "volume": [1000.0, 2000.0]}))
    captured = []
    monkeypatch.setattr(lsmr, "executemany", lambda sql, rows: captured.extend(rows))

    lsmr.score()

    assert len(captured) == 2
    stamp = captured[0][4]
    assert isinstance(stamp, datetime.datetime) and stamp.tzinfo is not None
    assert stamp.utcoffset() == datetime.timedelta(0)
    assert abs((datetime.datetime.now(datetime.timezone.utc) - stamp).total_seconds()) < 60
