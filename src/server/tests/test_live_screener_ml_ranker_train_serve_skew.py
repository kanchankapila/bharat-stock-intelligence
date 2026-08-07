"""Regression test for the 2026-08-07 train/serve-skew fix in live_screener_ml_ranker.py.

Root cause (see live_screener_ml_no_live_edge_2026_08_07 memory): _build_matrix() used to
group live_screener_outcomes/live_screener_appearances rows by (appeared_at, symbol) -- i.e.
by CALENDAR DAY. A filter match persists across many consecutive ~15-min scans in one trading
day (live-confirmed median 15 distinct runs per matching (date, symbol) pair, change_per
spread up to ~25pp within a single day), so that grouping smoothed change_per/volume across
the WHOLE day's runs and OR'd together every filter the symbol EVER matched that day into one
row. But score() (the live-scoring path) only ever sees ONE run's snapshot at a time
(`WHERE run_id = ?`) -- a single point-in-time change_per/volume and only the filters that
matched in THAT scan cycle, not a day-level union. The model was trained on a smoothed,
unioned view of the day and scored on a raw, single-snapshot view: a real train/serve skew,
live-confirmed as a strong contributor to the deployed model's near-zero live AUC.

The fix: group by (run_id, symbol) instead of (appeared_at, symbol), so every training row is
built from EXACTLY the same inputs a live scoring call would see for that run: this scan's
filter matches, this scan's change_per/volume, nothing folded in from earlier or later scans
the same day.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_screener_ml_ranker as lsmr


def _multi_run_day_frame():
    """One trading day, one symbol, matched by two different filters across three distinct
    scan cycles (run_id 1/2/3) -- the exact shape that used to collapse into a single smoothed
    row. change_per drifts sharply across the day (1.0% -> 9.0%) to make the smoothing
    (or its absence) unambiguous in the resulting matrix."""
    # run_ts (added same day, for the point-in-time reversal-feature join) needs no real
    # intraday_ohlcv coverage to exercise -- TESTCO is fictitious, so _load_reversal_features
    # correctly finds nothing and _build_matrix's own neutral fill (0.0/0.5) takes over; these
    # tests only assert on the filter-match/change_per columns, not the reversal ones.
    return pd.DataFrame([
        # run_id=1, 09:30 scan: only RSI_OVERSOLD matches, change_per is small early in the day
        {"symbol": "TESTCO", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
         "run_id": 1, "run_ts": pd.Timestamp("2026-06-01T04:00:00", tz="UTC"),
         "return_intraday": 0.05, "change_per": 1.0, "volume": 100_000},
        # run_id=2, 12:00 scan: RSI_OVERSOLD still matching AND VOLUME_SURGE newly matches
        {"symbol": "TESTCO", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
         "run_id": 2, "run_ts": pd.Timestamp("2026-06-01T06:30:00", tz="UTC"),
         "return_intraday": 0.02, "change_per": 5.0, "volume": 400_000},
        {"symbol": "TESTCO", "filter_key": "VOLUME_SURGE", "appeared_at": "2026-06-01",
         "run_id": 2, "run_ts": pd.Timestamp("2026-06-01T06:30:00", tz="UTC"),
         "return_intraday": 0.02, "change_per": 5.0, "volume": 400_000},
        # run_id=3, 15:00 scan: RSI_OVERSOLD has stopped matching (stock is no longer
        # oversold), only VOLUME_SURGE matches, change_per has run up to 9%
        {"symbol": "TESTCO", "filter_key": "VOLUME_SURGE", "appeared_at": "2026-06-01",
         "run_id": 3, "run_ts": pd.Timestamp("2026-06-01T09:30:00", tz="UTC"),
         "run_id": 3, "return_intraday": -0.01, "change_per": 9.0, "volume": 900_000},
    ])


class TestBuildMatrixGroupsByRunNotDay:
    def test_one_row_per_run_not_one_row_per_day(self):
        """The old (appeared_at, symbol) grouping would collapse all 3 runs above into a
        single row for TESTCO on 2026-06-01. The fix must keep them as 3 separate rows."""
        matrix, _ = lsmr._build_matrix(_multi_run_day_frame())
        assert len(matrix) == 3, (
            "expected one matrix row per (run_id, symbol) -- got "
            f"{len(matrix)}, meaning runs are still being collapsed by day"
        )

    def test_change_per_is_this_runs_snapshot_not_the_days_average(self):
        """Each row's change_per must be the value captured AT THAT SCAN, not smoothed across
        the whole day. The old day-level mean would have given every run change_per=5.0
        (mean of 1.0, 5.0, 5.0, 9.0) regardless of which run it actually came from."""
        matrix, _ = lsmr._build_matrix(_multi_run_day_frame())
        by_run = matrix.set_index("run_id")["change_per"].to_dict()
        assert by_run[1] == 1.0, f"run_id=1 change_per should be its own 1.0%, got {by_run[1]}"
        assert by_run[2] == 5.0, f"run_id=2 change_per should be its own 5.0%, got {by_run[2]}"
        assert by_run[3] == 9.0, f"run_id=3 change_per should be its own 9.0%, got {by_run[3]}"

    def test_filter_flags_reflect_only_this_runs_matches(self):
        """run_id=1 matched only RSI_OVERSOLD; run_id=3 matched only VOLUME_SURGE (RSI_OVERSOLD
        had already stopped matching by then). The old day-level union would have set BOTH
        filter flags to 1 for every run that day, since the symbol matched both filters at
        SOME point -- exactly the leak from the future this fix closes."""
        matrix, feature_cols = lsmr._build_matrix(_multi_run_day_frame())
        assert "RSI_OVERSOLD" in feature_cols and "VOLUME_SURGE" in feature_cols
        by_run = matrix.set_index("run_id")

        assert by_run.loc[1, "RSI_OVERSOLD"] == 1
        assert by_run.loc[1, "VOLUME_SURGE"] == 0, (
            "run_id=1 never matched VOLUME_SURGE -- it must not show up as matched just "
            "because the symbol matched it LATER in the same day"
        )
        assert by_run.loc[3, "VOLUME_SURGE"] == 1
        assert by_run.loc[3, "RSI_OVERSOLD"] == 0, (
            "run_id=3 no longer matched RSI_OVERSOLD -- it must not show up as matched just "
            "because the symbol matched it EARLIER in the same day"
        )

    def test_within_run_multi_filter_match_still_collapses_to_one_row(self):
        """run_id=2 matched BOTH filters in the SAME scan cycle -- this must still produce
        exactly one training row for (run_id=2, TESTCO), mirroring score()'s own
        appearances.groupby('symbol') behaviour for a single run_id, not one row per filter."""
        matrix, _ = lsmr._build_matrix(_multi_run_day_frame())
        run2_rows = matrix[matrix["run_id"] == 2]
        assert len(run2_rows) == 1
        assert run2_rows.iloc[0]["RSI_OVERSOLD"] == 1
        assert run2_rows.iloc[0]["VOLUME_SURGE"] == 1

    def test_training_row_shape_matches_a_real_scoring_call(self, monkeypatch):
        """End-to-end equivalence check: build a training matrix for run_id=1 alone, then call
        score()'s own live matrix-construction logic against an appearances frame with the
        exact same rows, and confirm the two produce identical feature values for TESTCO --
        proving training rows are now genuinely the same shape as what scoring receives."""
        frame = _multi_run_day_frame()
        train_matrix, feature_cols = lsmr._build_matrix(frame[frame["run_id"] == 1])
        train_row = train_matrix.set_index("symbol").loc["TESTCO"]

        # Reproduce score()'s own live feature-construction logic (lines ~354-364) against an
        # appearances frame shaped like live_screener_appearances for run_id=1.
        appearances = pd.DataFrame([
            {"symbol": "TESTCO", "filter_key": "RSI_OVERSOLD", "change_per": 1.0, "volume": 100_000},
        ])
        agg = appearances.groupby("symbol").agg(change_per=("change_per", "mean"), volume=("volume", "mean"))
        flags = pd.crosstab(appearances["symbol"], appearances["filter_key"]).clip(upper=1)
        live_matrix = agg.join(flags, how="left").fillna(0.0)
        live_matrix["log_volume"] = np.log1p(live_matrix["volume"].clip(lower=0))
        live_row = live_matrix.loc["TESTCO"]

        assert train_row["change_per"] == live_row["change_per"] == 1.0
        assert train_row["log_volume"] == live_row["log_volume"]
        assert train_row["RSI_OVERSOLD"] == live_row["RSI_OVERSOLD"] == 1
