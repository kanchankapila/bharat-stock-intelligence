"""Tests for the 2026-08-07 reversal-feature addition to live_screener_ml_ranker.py.

Adds vwap_deviation_pct / intraday_range_pos -- the SAME two inputs intraday_ranker.py's
_reversal_scores() already computes and this platform has independently validated as its
best-ranked intraday signal (IC -0.090 t=-5.7 at 10:15, 2026-07-31 intraday audit). Neither
was previously fed into live_screener_ml_ranker.py's model at all -- its only features were
raw filter-match flags + change_per/log_volume, which the same-day investigation measured as
carrying essentially no honest signal (see live_screener_ml_no_live_edge_2026_08_07 memory).

The critical correctness property under test is point-in-time-ness: a training row for a run
at 10:00 must be built ONLY from bars up to and including 10:00, never from later bars the
same day (that would reintroduce the exact class of leak this file was fixed for earlier the
same day, in a new guise) -- and a run must never see a different trading day's bars at all.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_screener_ml_ranker as lsmr


def _rising_price_bars():
    """One symbol, one day, 4 bars, price rising 100 -> 110 with widening range."""
    return pd.DataFrame([
        {"symbol": "TESTCO", "datetime": pd.Timestamp("2026-06-01T03:45:00", tz="UTC"),
         "high": 101, "low": 99, "close": 100, "volume": 1000},
        {"symbol": "TESTCO", "datetime": pd.Timestamp("2026-06-01T04:00:00", tz="UTC"),
         "high": 103, "low": 100, "close": 102, "volume": 1000},
        {"symbol": "TESTCO", "datetime": pd.Timestamp("2026-06-01T04:15:00", tz="UTC"),
         "high": 108, "low": 102, "close": 107, "volume": 1000},
        {"symbol": "TESTCO", "datetime": pd.Timestamp("2026-06-01T04:30:00", tz="UTC"),
         "high": 112, "low": 107, "close": 110, "volume": 1000},
    ])


class TestAsofReversalForDate:
    def test_matches_manual_vwap_and_range_calculation(self):
        """as_of=04:00 sees only the first 2 bars. Manual check: typical prices
        (101+99+100)/3=100 and (103+100+102)/3=101.667; pv=201666.67, v=2000,
        vwap=100.833; last close=102 -> vwap_dev=(102-100.833)/100.833*100=1.157%.
        range: hi=103, lo=99 -> range_pos=(102-99)/(103-99)=0.75."""
        bars = _rising_price_bars()
        as_of = pd.DataFrame({"run_id": [1], "symbol": ["TESTCO"],
                               "ts": [pd.Timestamp("2026-06-01T04:00:00", tz="UTC")]})
        result = lsmr._asof_reversal_for_date(bars, as_of)
        assert result.iloc[0]["vwap_deviation_pct"] == pytest.approx(1.157, abs=0.01)
        assert result.iloc[0]["intraday_range_pos"] == pytest.approx(0.75, abs=0.001)

    def test_a_run_cannot_see_later_bars_the_same_day(self):
        """The whole point of this feature: a run at 04:00 and a run at 04:30 must compute
        DIFFERENT values, because the 04:00 run must not see the 04:15/04:30 bars. If it did
        (the leak this test exists to catch), both would report the same, final-of-day value."""
        bars = _rising_price_bars()
        early = pd.DataFrame({"run_id": [1], "symbol": ["TESTCO"],
                               "ts": [pd.Timestamp("2026-06-01T04:00:00", tz="UTC")]})
        late = pd.DataFrame({"run_id": [2], "symbol": ["TESTCO"],
                              "ts": [pd.Timestamp("2026-06-01T04:30:00", tz="UTC")]})
        r_early = lsmr._asof_reversal_for_date(bars, early)
        r_late = lsmr._asof_reversal_for_date(bars, late)
        assert r_early.iloc[0]["vwap_deviation_pct"] != r_late.iloc[0]["vwap_deviation_pct"], (
            "an early run must not see the same VWAP deviation as a later run on a rising day "
            "-- this would mean it leaked future bars"
        )

    def test_a_run_between_bars_only_sees_bars_strictly_before_it(self):
        """A real production run_id's timestamp almost never lands exactly on a 15-min bar
        boundary (it's stamped whenever the collector job actually ran). as_of=04:05 (between
        the 04:00 and 04:15 bars) must match the 04:00 bar's cumulative state -- if the merge
        direction were wrong (matching forward instead of backward), it would instead pick up
        the 04:15 bar, silently pulling in a future bar's high/close."""
        bars = _rising_price_bars()
        as_of = pd.DataFrame({"run_id": [1], "symbol": ["TESTCO"],
                               "ts": [pd.Timestamp("2026-06-01T04:05:00", tz="UTC")]})
        result = lsmr._asof_reversal_for_date(bars, as_of)
        # As of 04:00 (2 bars): vwap~100.833, close=102 -> vwap_dev~1.157%, range_pos=0.75
        # (same as test_matches_manual_vwap_and_range_calculation -- 04:05 must match the
        # exact same cumulative state as 04:00, since nothing new has printed by 04:05).
        assert result.iloc[0]["vwap_deviation_pct"] == pytest.approx(1.157, abs=0.01)
        assert result.iloc[0]["intraday_range_pos"] == pytest.approx(0.75, abs=0.001)

    def test_scalar_broadcast_ts_dtype_does_not_crash_merge_asof(self):
        """score()'s real construction (`pd.DataFrame({'ts': run_ts, ...})` with run_ts a bare
        scalar datetime.datetime from query_one()'s raw cursor read, broadcast against the
        symbol index) produces datetime64[us, UTC], while bars['datetime'] (built via
        pd.to_datetime() over a read_df()-sourced Series) is datetime64[ns, UTC] --
        merge_asof raises a hard MergeError on that mismatch rather than silently coercing.
        Live-caught 2026-08-07: --train worked (both sides come from read_df(), same dtype)
        but --score crashed against the real DB on exactly this. Reproduces the precise
        scalar-broadcast shape rather than a list-wrapped column, which pandas normalizes to
        [ns] and does NOT reproduce the bug.

        UPDATED 2026-08-10: the mismatch is now constructed EXPLICITLY via .astype() instead
        of relying on pandas producing it incidentally. Under pandas 3.0.3 both sides come
        back as datetime64[us, UTC], so the scalar-broadcast trick no longer reproduces it and
        this test's own setup assertion (correctly) started failing -- it was guarding nothing.
        Pinning both dtypes keeps the production code under test across pandas versions;
        whether a given pandas happens to produce the mismatch is not the point, surviving it
        is.
        """
        import datetime
        bars = _rising_price_bars()
        bars = bars.assign(datetime=bars["datetime"].astype("datetime64[ns, UTC]"))
        raw_dt = datetime.datetime(2026, 6, 1, 4, 30, 0, tzinfo=datetime.timezone.utc)
        idx = pd.Index(["TESTCO"], name="symbol")
        as_of = pd.DataFrame({"run_id": 1, "symbol": idx, "ts": raw_dt})
        as_of["ts"] = as_of["ts"].astype("datetime64[us, UTC]")
        assert as_of["ts"].dtype != bars["datetime"].dtype, (
            "test setup didn't reproduce the real dtype mismatch -- adjust the construction"
        )
        result = lsmr._asof_reversal_for_date(bars, as_of)  # must not raise MergeError
        assert not result.empty

    def test_asof_before_any_bar_is_nan_not_zero(self):
        """A run timestamped before the session's first bar has genuinely nothing to compute
        from -- must be NaN (an honest 'no data'), never silently 0.0 (a fake 'at VWAP')."""
        bars = _rising_price_bars()
        as_of = pd.DataFrame({"run_id": [1], "symbol": ["TESTCO"],
                               "ts": [pd.Timestamp("2026-06-01T03:00:00", tz="UTC")]})
        result = lsmr._asof_reversal_for_date(bars, as_of)
        assert pd.isna(result.iloc[0]["vwap_deviation_pct"])
        assert pd.isna(result.iloc[0]["intraday_range_pos"])

    def test_empty_bars_or_empty_asof_returns_empty_with_expected_columns(self):
        cols = ["run_id", "symbol", "vwap_deviation_pct", "intraday_range_pos"]
        empty_bars = pd.DataFrame(columns=["symbol", "datetime", "high", "low", "close", "volume"])
        as_of = pd.DataFrame({"run_id": [1], "symbol": ["TESTCO"], "ts": [pd.Timestamp.utcnow()]})
        result = lsmr._asof_reversal_for_date(empty_bars, as_of)
        assert result.empty and list(result.columns) == cols

        result2 = lsmr._asof_reversal_for_date(_rising_price_bars(), pd.DataFrame(columns=["run_id", "symbol", "ts"]))
        assert result2.empty and list(result2.columns) == cols


class TestLoadReversalFeaturesCrossDaySafety:
    def test_a_run_on_day_2_never_sees_day_1s_bars(self, monkeypatch):
        """_load_reversal_features processes one session_date at a time -- a run on
        2026-06-02 querying _load_intraday_bars_for_date must only ever receive that date's
        bars, structurally unable to pick up 2026-06-01's bars regardless of price
        continuity between the two days."""
        calls = []

        def fake_loader(session_date):
            calls.append(session_date)
            if session_date == "2026-06-01":
                return pd.DataFrame([
                    {"symbol": "TESTCO", "datetime": pd.Timestamp("2026-06-01T09:00:00", tz="UTC"),
                     "high": 500, "low": 490, "close": 495, "volume": 1000},
                ])
            elif session_date == "2026-06-02":
                return pd.DataFrame([
                    {"symbol": "TESTCO", "datetime": pd.Timestamp("2026-06-02T04:00:00", tz="UTC"),
                     "high": 105, "low": 95, "close": 100, "volume": 1000},
                ])
            return pd.DataFrame(columns=["symbol", "datetime", "high", "low", "close", "volume"])

        monkeypatch.setattr(lsmr, "_load_intraday_bars_for_date", fake_loader)

        run_asof = pd.DataFrame([
            {"run_id": 1, "symbol": "TESTCO", "ts": pd.Timestamp("2026-06-02T04:00:00", tz="UTC"),
             "session_date": "2026-06-02"},
        ])
        result = lsmr._load_reversal_features(run_asof)
        assert calls == ["2026-06-02"], (
            "must only load bars for the dates actually present in run_asof -- day 1 was "
            "requested even though no run needed it"
        )
        # If day 1's 490-500 price band had leaked in, vwap_dev would be wildly different
        # (close=100 against a vwap computed from 495-region prices would be ~-80%, not ~0%).
        assert abs(result.iloc[0]["vwap_deviation_pct"]) < 5.0, (
            "vwap_deviation_pct looks contaminated by the wrong day's price level"
        )

    def test_missing_intraday_coverage_is_a_graceful_skip_not_a_crash(self, monkeypatch):
        """A date with zero intraday_ohlcv rows (a real, known coverage gap) must not raise --
        the caller (_build_matrix) fills the resulting NaN with a neutral default."""
        monkeypatch.setattr(lsmr, "_load_intraday_bars_for_date",
                             lambda d: pd.DataFrame(columns=["symbol", "datetime", "high", "low", "close", "volume"]))
        run_asof = pd.DataFrame([
            {"run_id": 1, "symbol": "TESTCO", "ts": pd.Timestamp("2026-06-02T04:00:00", tz="UTC"),
             "session_date": "2026-06-02"},
        ])
        result = lsmr._load_reversal_features(run_asof)
        assert result.empty or pd.isna(result.iloc[0]["vwap_deviation_pct"])

    def test_a_loader_exception_for_one_date_does_not_abort_other_dates(self, monkeypatch):
        """Mirrors this file's established resilience convention (e.g. _live_auc()'s own
        try/except) -- one date's DB failure must not silently drop every other date's
        reversal features too."""
        def flaky_loader(session_date):
            if session_date == "2026-06-01":
                raise RuntimeError("simulated DB error")
            return pd.DataFrame([
                {"symbol": "TESTCO", "datetime": pd.Timestamp("2026-06-02T04:00:00", tz="UTC"),
                 "high": 105, "low": 95, "close": 100, "volume": 1000},
            ])
        monkeypatch.setattr(lsmr, "_load_intraday_bars_for_date", flaky_loader)

        run_asof = pd.DataFrame([
            {"run_id": 1, "symbol": "TESTCO", "ts": pd.Timestamp("2026-06-01T04:00:00", tz="UTC"),
             "session_date": "2026-06-01"},
            {"run_id": 2, "symbol": "TESTCO", "ts": pd.Timestamp("2026-06-02T04:00:00", tz="UTC"),
             "session_date": "2026-06-02"},
        ])
        result = lsmr._load_reversal_features(run_asof)
        assert len(result) == 1
        assert result.iloc[0]["run_id"] == 2


class TestBuildMatrixIncludesReversalFeatures:
    def test_feature_cols_include_the_new_reversal_columns(self, monkeypatch):
        monkeypatch.setattr(lsmr, "_load_reversal_features",
                             lambda run_asof: lsmr._empty_reversal_frame())

        df = pd.DataFrame([
            {"symbol": "TESTCO", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
             "run_id": 1, "run_ts": pd.Timestamp("2026-06-01T04:00:00", tz="UTC"),
             "return_intraday": 0.01, "change_per": 1.0, "volume": 100_000},
        ])
        matrix, feature_cols = lsmr._build_matrix(df)
        assert "vwap_deviation_pct" in feature_cols
        assert "intraday_range_pos" in feature_cols
        # No real bars were provided (empty mocked reversal) -- must be neutrally filled, not NaN.
        assert matrix.iloc[0]["vwap_deviation_pct"] == 0.0
        assert matrix.iloc[0]["intraday_range_pos"] == 0.5

    def test_neutral_fill_is_not_generic_zero_for_range_pos(self, monkeypatch):
        """A blanket .fillna(0.0) (what train() applies to the WHOLE feature matrix
        downstream) would silently claim every coverage-gap row sat at the day's LOW --
        _build_matrix must apply its own semantically-correct 0.5 fill for intraday_range_pos
        before that generic fill ever runs."""
        monkeypatch.setattr(lsmr, "_load_reversal_features",
                             lambda run_asof: lsmr._empty_reversal_frame())
        df = pd.DataFrame([
            {"symbol": "TESTCO", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
             "run_id": 1, "run_ts": pd.Timestamp("2026-06-01T04:00:00", tz="UTC"),
             "return_intraday": 0.01, "change_per": 1.0, "volume": 100_000},
        ])
        matrix, _ = lsmr._build_matrix(df)
        assert matrix.iloc[0]["intraday_range_pos"] != 0.0, (
            "a coverage gap must fill intraday_range_pos with 0.5 (neutral), not 0.0 "
            "(which falsely claims the stock sat at its intraday low)"
        )
