"""Regression tests for mc_price_features_ohlcv.compute_features (2026-10-11 quant audit).

Every case here is a point-in-time property, not a value check: a feature may only use
data up to and including the row it describes. The two bugs these lock down both produced
plausible-looking numbers while reading data the stock could not yet have made.
"""
import numpy as np
import pandas as pd
import pytest

from mc_price_features_ohlcv import compute_features


def _ohlcv(closes, volumes=None, start="2023-01-02"):
    n = len(closes)
    dates = pd.bdate_range(start, periods=n)
    return pd.DataFrame({
        "date":   dates.strftime("%Y-%m-%d"),
        "close":  np.asarray(closes, dtype=float),
        "volume": np.asarray(volumes if volumes is not None
                             else np.full(n, 1_000_000.0), dtype=float),
    })


class TestYtdReturnBaseline:
    """YTD must be measured from the prior calendar year's LAST close."""

    def test_prior_year_close_baseline_not_current_year_first_close(self):
        # 2023: 10 sessions ending at 100. 2024: 3 sessions, the first of which gaps +5%.
        closes = [90 + i for i in range(10)] + [105.0, 110.0, 115.0]
        out = compute_features(_ohlcv(closes, start="2023-12-18"))
        row_2024 = out[out["date"].str.startswith("2024")].iloc[0]

        # Correct baseline: prior year's last close = 99 -> (105-99)/99
        assert row_2024["mc_ytd_return"] == pytest.approx(round((105.0 - 99.0) / 99.0 * 100, 2))
        # The old baseline (first close OF the year) yields exactly 0 on the first
        # session, silently dropping that session's move -- assert it is NOT that.
        assert row_2024["mc_ytd_return"] != 0.0

    def test_first_year_falls_back_to_first_close(self):
        """The earliest year in the frame has no prior-year close; it must fall back to
        its own first close (the honest 'since first available bar' baseline)."""
        out = compute_features(_ohlcv([100.0, 102.0, 104.0], start="2025-01-01"))
        assert out["mc_ytd_return"].iloc[0] == pytest.approx(0.0)
        assert out["mc_ytd_return"].iloc[2] == pytest.approx(4.0)

    def test_ytd_is_flat_within_a_year_without_a_year_boundary(self):
        closes = [100.0, 101.0, 102.0]
        out = compute_features(_ohlcv(closes, start="2025-02-02"))
        assert out["mc_ytd_return"].tolist() == pytest.approx([0.0, 1.0, 2.0])

    def test_ytd_does_not_change_when_future_bars_are_appended(self):
        """The core point-in-time invariant: appending later sessions must not rewrite
        an earlier session's YTD. This is what the old transform('last').shift(1)
        baseline violated -- it aligned to the PREVIOUS ROW, so every mid-year row was
        computed against that year's own eventual last close (pure look-ahead)."""
        closes = [90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 105, 110, 115]
        full = compute_features(_ohlcv(closes, start="2023-12-20"))
        truncated = compute_features(_ohlcv(closes[:10], start="2023-12-20"))
        # Rows present in both must agree exactly.
        shared = full[full["date"].isin(truncated["date"])]["mc_ytd_return"].to_numpy()
        assert shared == pytest.approx(truncated["mc_ytd_return"].to_numpy())


class TestDaysFrom52wHigh:
    def test_most_recent_touch_wins_on_ties(self):
        """High made 5 bars ago, matched again on the most recent bar -> 0, not 5."""
        closes = [100.0, 120.0, 110.0, 115.0, 119.0, 120.0]
        out = compute_features(_ohlcv(closes))
        assert out["mc_days_from_52wh"].iloc[-1] == 0

    def test_counts_sessions_since_the_high(self):
        closes = [100.0, 120.0, 110.0, 115.0, 119.0]
        out = compute_features(_ohlcv(closes))
        # High of 120 sits 3 sessions back from the last bar.
        assert out["mc_days_from_52wh"].iloc[-1] == 3

    def test_zero_on_a_fresh_high(self):
        closes = [100.0, 101.0, 102.0, 103.0]
        out = compute_features(_ohlcv(closes))
        assert out["mc_days_from_52wh"].iloc[-1] == 0


class TestRollingWindowMinPeriods:
    def test_ma_windows_are_nan_before_their_min_periods(self):
        out = compute_features(_ohlcv([100.0] * 5, start="2025-01-01"))
        assert out["mc_ma30_dist_pct"].isna().all()
        assert out["mc_ma200_dist_pct"].isna().all()

    def test_52w_high_is_defined_from_the_first_bar(self):
        """min_periods=1 on the 52w window: no false 'no data' before a full year exists."""
        out = compute_features(_ohlcv([100.0, 110.0, 105.0]))
        assert out["mc_52w_high_dist_pct"].iloc[0] == pytest.approx(0.0)
        assert out["mc_52w_high_dist_pct"].iloc[1] == pytest.approx(0.0)
        assert out["mc_52w_high_dist_pct"].iloc[2] == pytest.approx(round((105 - 110) / 110 * 100, 2))


class TestVolumeRatio:
    def test_excludes_today_from_the_average(self):
        """avg_vol20 is shift(1).rolling(20): today's own volume is NOT in its own
        baseline, otherwise a volume spike would inflate the denominator it is measured
        against and under-report the spike."""
        volumes = [1_000_000.0] * 20 + [3_000_000.0]
        out = compute_features(_ohlcv([100.0] * 21, volumes=volumes))
        assert out["mc_vol_ratio"].iloc[-1] == pytest.approx(3.0)

    def test_nan_before_min_periods(self):
        out = compute_features(_ohlcv([100.0] * 5))
        assert out["mc_vol_ratio"].isna().all()
