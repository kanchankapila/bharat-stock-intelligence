"""Regression test for the 2026-07-30 fifth full-stack-audit pass: live_screener_ml_ranker.py's
TimeSeriesSplit had no explicit gap= embargo, unlike every other CV site in this codebase
(ml_ensemble.py, cs_ranker.py, confluence_ml_engine.py, ml_signal_scorer.py all pass gap=embargo).
Assessed as not a demonstrated leak (this label is same-day intraday resolution, not multi-day
forward-return, so there's no forward window past the split boundary to leak into), but fixed
for defensive consistency with the rest of the codebase's convention: gap=1.

This test constructs a synthetic training frame (bypassing the real DB) and confirms train()
runs end-to-end without crashing under the new gap=1 split, and that the split itself carries
the gap.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_screener_ml_ranker as lsmr


def _synthetic_training_frame(n_dates=20, symbols_per_day=15):
    dates = pd.bdate_range("2026-06-01", periods=n_dates).strftime("%Y-%m-%d")
    rows = []
    rng = np.random.default_rng(42)
    for d in dates:
        for i in range(symbols_per_day):
            symbol = f"SYM{i}"
            change_per = float(rng.normal(0, 2))
            volume = float(rng.integers(10_000, 1_000_000))
            filter_key = "RSI_OVERSOLD" if i % 3 == 0 else "VOLUME_SURGE"
            return_intraday = change_per / 100.0 + float(rng.normal(0, 0.01))
            rows.append({
                "symbol": symbol, "filter_key": filter_key, "appeared_at": d,
                "return_intraday": return_intraday, "change_per": change_per, "volume": volume,
            })
    return pd.DataFrame(rows)


class TestTimeSeriesSplitHasEmbargoGap:
    def test_train_uses_gap_of_one(self, monkeypatch, tmp_path):
        monkeypatch.setattr(lsmr, "_load_training_frame", lambda: _synthetic_training_frame())
        monkeypatch.setattr(lsmr, "MODEL_PATH", str(tmp_path / "model.pkl"))
        monkeypatch.setattr(lsmr, "CANDIDATE_PATH", str(tmp_path / "model_candidate.pkl"))
        monkeypatch.setattr(lsmr, "_load_active_metrics", lambda: None)
        monkeypatch.setattr(lsmr, "execute", lambda *a, **k: None)

        captured_splits = {}
        from sklearn.model_selection import TimeSeriesSplit
        real_init = TimeSeriesSplit.__init__

        def spy_init(self, *args, **kwargs):
            captured_splits["gap"] = kwargs.get("gap")
            return real_init(self, *args, **kwargs)

        monkeypatch.setattr(TimeSeriesSplit, "__init__", spy_init)

        lsmr.train()

        assert captured_splits.get("gap") == 1, (
            "live_screener_ml_ranker.py's TimeSeriesSplit must pass gap=1 for consistency with "
            "every other CV site in this codebase (ml_ensemble.py/cs_ranker.py/"
            "confluence_ml_engine.py/ml_signal_scorer.py)"
        )
        assert os.path.exists(str(tmp_path / "model.pkl")) or os.path.exists(str(tmp_path / "model_candidate.pkl")), (
            "train() should produce either a promoted model or a rejected candidate artifact"
        )
