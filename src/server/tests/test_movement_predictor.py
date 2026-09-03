"""
Tests for movement_predictor.py — pure label/lag construction (no DB, no network), plus
regression coverage for two fixes made this session:

1. min_child_samples was hardcoded to 200 in _make_model/_purged_oof, which structurally
   blocks LightGBM from ever splitting on a sparse-but-real enrichment feature (e.g.
   mc_tech_rating had only ~130 non-zero rows in a ~60-day window) regardless of whether it's
   predictive. Fixed to accept a caller-supplied value; the enrichment tier now uses 30.
2. mc_tech_rating was wired into ENRICH_FEATURE_COLS + load_ts_precursors's lagged-column
   list (with the same leak-safe one-day lag as the other enrichment columns), after raw
   correlation checks against next-day range showed a real, reproducible signal (0.15-0.27
   across two independent sample windows) that no existing model was testing for.

movement_predictor.py is NOT a data-source fetcher (no `requests` import, purely a DB-read +
compute script) — it does not need a @pytest.mark.live_datasource test per CLAUDE.md's rule,
which only applies to fetchers hitting an external URL/API.
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from movement_predictor import (
    build_movement_labels, _lag_by_symbol, _make_model, _purged_oof,
    ENRICH_FEATURE_COLS, MIN_PRICE, MIN_TURNOVER_CR, TOP_PCT,
    OHLCV_FEATURE_COLS,
)
from breakout_classifier import compute_ohlcv_features


def _long_ohlcv(data: dict, n_days: int) -> pd.DataFrame:
    """data: {symbol: {"close": [...], "high": [...], "low": [...], "volume": [...]}}"""
    dates = pd.date_range("2026-01-01", periods=n_days, freq="B").strftime("%Y-%m-%d")
    rows = []
    for symbol, series in data.items():
        for i, d in enumerate(dates):
            rows.append({
                "symbol": symbol, "date": d,
                "close": series["close"][i], "high": series["high"][i],
                "low": series["low"][i], "volume": series["volume"][i],
            })
    return pd.DataFrame(rows)


class TestBuildMovementLabels:
    def test_wide_range_day_ranks_above_narrow_range_day(self):
        """A cross-sectional universe of liquid stocks where one symbol has a much wider
        day-range than the rest on a given day should rank that symbol/day pair higher."""
        n = 25
        base_close = [100.0] * n
        base_high = [101.0] * n
        base_low = [99.0] * n
        vol = [200_000] * n  # 200k shares * ~100 price / 1e7 = 2 Cr turnover, above MIN_TURNOVER_CR

        wide_high = list(base_high)
        wide_low = list(base_low)
        wide_high[20] = 115.0  # big range day
        wide_low[20] = 95.0

        data = {}
        # Several "flat" symbols to give the cross-sectional rank something to rank against.
        for sym in ["B", "C", "D", "E", "F"]:
            data[sym] = {"close": base_close, "high": base_high, "low": base_low, "volume": vol}
        data["A"] = {"close": base_close, "high": wide_high, "low": wide_low, "volume": vol}

        ohlcv = _long_ohlcv(data, n)
        labels = build_movement_labels(ohlcv)

        row = labels[(labels["symbol"] == "A") & (labels["date"] == ohlcv["date"].unique()[20])]
        assert len(row) == 1
        assert int(row["moved"].iloc[0]) == 1
        assert row["day_range_pct"].iloc[0] > 15.0  # (115-95)/100*100

    def test_penny_stock_excluded_from_eligibility(self):
        """A stock trading below MIN_PRICE must never be labelled moved=1, however wide its
        range, since it's excluded from the eligible ranking universe entirely."""
        n = 25
        assert MIN_PRICE > 5.0  # sanity: this test's premise depends on the real threshold
        close = [5.0] * n
        high = [5.0] * n
        low = [5.0] * n
        high[10], low[10] = 7.0, 3.0  # huge % range, but still a penny stock
        vol = [500_000] * n

        data = {"PENNY": {"close": close, "high": high, "low": low, "volume": vol}}
        ohlcv = _long_ohlcv(data, n)
        labels = build_movement_labels(ohlcv)
        assert set(labels["moved"].unique()) <= {0}

    def test_illiquid_stock_excluded_by_turnover_floor(self):
        """A stock priced above MIN_PRICE but with near-zero volume (turnover well under
        MIN_TURNOVER_CR) must also be excluded from the eligible ranking universe."""
        n = 25
        close = [100.0] * n
        high = [100.0] * n
        low = [100.0] * n
        high[10], low[10] = 120.0, 80.0
        vol = [1] * n  # ~1 share/day traded -- far below MIN_TURNOVER_CR
        assert MIN_TURNOVER_CR > 0

        data = {"ILLIQUID": {"close": close, "high": high, "low": low, "volume": vol}}
        ohlcv = _long_ohlcv(data, n)
        labels = build_movement_labels(ohlcv)
        assert set(labels["moved"].unique()) <= {0}


class TestLagBySymbol:
    def test_shifts_forward_one_row_per_symbol_independently(self):
        """Row labelled date d must carry the PRIOR row's value for each symbol independently
        -- this is the exact mechanism load_ts_precursors relies on to avoid a same-day leak
        when joining technical_signals (an EOD-computed row) onto day d's label."""
        df = pd.DataFrame({
            "symbol": ["A", "A", "A", "B", "B", "B"],
            "date":   ["2026-01-01", "2026-01-02", "2026-01-03"] * 2,
            "val":    [10, 20, 30, 100, 200, 300],
        })
        out = _lag_by_symbol(df, ["val"])
        out = out.sort_values(["symbol", "date"]).reset_index(drop=True)

        a = out[out["symbol"] == "A"]["val"].tolist()
        b = out[out["symbol"] == "B"]["val"].tolist()
        assert a[0] != a[0] or pd.isna(a[0])  # first row has no prior -> NaN
        assert a[1:] == [10, 20]
        assert b[1:] == [100, 200]


class TestScoreUsesLaggedFeatures:
    def test_latest_date_feature_row_must_come_from_the_prior_day_not_same_day(self):
        """Regression guard for the 2026-08-20 train/serve-skew fix in score(): load_training_data()
        merges labels(d) against _lag_by_symbol(compute_ohlcv_features(...))(d), i.e. a row
        labelled date d carries date d-1's raw feature values. score() must feed the model the
        identical composition -- using date d's own just-closed OHLCV to "predict" date d's own
        day-range label is a same-day leak (the live column's implausibly high AUC against its
        own native label traced back to exactly this), not a live, pre-market-actionable score."""
        n = 25
        vol = [200_000] * n
        vol[-1] = 5_000_000  # spike ONLY on the latest day -> vol_ratio only moves on that row
        close = [100.0 + i * 0.1 for i in range(n)]
        high = [c + 1.0 for c in close]
        low = [c - 1.0 for c in close]
        ohlcv = _long_ohlcv({"A": {"close": close, "high": high, "low": low, "volume": vol}}, n)

        raw = compute_ohlcv_features(ohlcv)
        lagged = _lag_by_symbol(raw, OHLCV_FEATURE_COLS)

        dates_sorted = sorted(raw["date"].unique())
        latest, prior = dates_sorted[-1], dates_sorted[-2]
        raw_latest = raw[raw["date"] == latest].iloc[0]
        raw_prior = raw[raw["date"] == prior].iloc[0]
        lagged_latest = lagged[lagged["date"] == latest].iloc[0]

        # vol_ratio only spikes on the volume-spike day itself -- proves the fix's composition
        # picks up the PRIOR day's (unspiked) value for "today", not the same-day spiked one.
        assert raw_latest["vol_ratio"] > 5.0  # sanity: the spike really did move the raw feature
        assert lagged_latest["vol_ratio"] == pytest.approx(raw_prior["vol_ratio"])
        assert lagged_latest["vol_ratio"] != pytest.approx(raw_latest["vol_ratio"])


class TestEnrichmentWiring:
    def test_mc_tech_rating_is_wired_into_enrichment_columns(self):
        """Regression guard for this session's fix: mc_tech_rating must stay in
        ENRICH_FEATURE_COLS (and therefore get evaluated by the --enrich lift check) rather
        than silently falling back out on a future refactor."""
        assert "mc_tech_rating" in ENRICH_FEATURE_COLS


class TestMinChildSamplesParameterization:
    def test_make_model_respects_custom_min_child_samples(self):
        """Regression guard: _make_model must actually thread a custom min_child_samples
        into the LightGBM config, not silently keep the CORE model's hardcoded 200. This is
        the exact parameter whose hardcoding made the enrichment lift check structurally
        blind to sparse-but-real features (see module docstring)."""
        model_default = _make_model(spw=1.0)
        model_custom = _make_model(spw=1.0, min_child_samples=30)
        assert model_default.get_params()["min_child_samples"] == 200
        assert model_custom.get_params()["min_child_samples"] == 30

    def test_purged_oof_runs_with_custom_min_child_samples(self):
        """Functional smoke test: _purged_oof must accept and use a custom min_child_samples
        without erroring, on a small synthetic cross-sectional dataset shaped like the real
        enrichment window (many dates, a handful of symbols, a rare positive class)."""
        n_days = 40
        symbols = ["A", "B", "C", "D", "E", "F"]
        rows = []
        dates = pd.date_range("2026-01-01", periods=n_days, freq="B").strftime("%Y-%m-%d")
        rng = np.random.RandomState(42)
        for d_idx, d in enumerate(dates):
            for sym in symbols:
                rows.append({
                    "symbol": sym, "date": d,
                    "moved": 1 if (rng.rand() < 0.1) else 0,
                    "feat_a": rng.randn(), "feat_b": rng.randn(),
                })
        df = pd.DataFrame(rows)
        auc, lift, base_rate = _purged_oof(df, ["feat_a", "feat_b"], n_folds=2, min_child_samples=5)
        # With only ~240 rows total and a 5-leaf floor, a result may or may not clear the
        # internal row-count guards -- the point of this test is that it runs without raising,
        # not that it produces a specific AUC on random noise features.
        assert base_rate is not None and 0.0 <= base_rate <= 1.0
