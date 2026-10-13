"""Regression tests for the 2026-10-11 quant-audit fix to backfill_pe_valuation_bands.py.

The band a stock's P/E is compared against must be the trailing 3-year window ENDING AT
THE ROW'S OWN DATE. The old code computed one set of percentiles over the whole 3-year
slice and stamped those same five numbers onto each of the last 60 sessions, so a row
dated 45 days ago was a function of today's P/E -- a look-ahead baked into a column that
backtests and screens read as "cheap vs its own 3-year band".
"""
import datetime as dt
import importlib.util
from pathlib import Path

import numpy as np
import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "backfill_pe_valuation_bands.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("backfill_pe_valuation_bands", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # module-level code is load_dotenv() only
    return module


@pytest.fixture(scope="module")
def band_mod():
    return _load_module()


def _ramp_series(n: int, start: float, end: float, base: dt.date = dt.date(2024, 1, 1)):
    """Strictly monotonic P/E series, one observation per calendar day."""
    step = (end - start) / (n - 1)
    return [(base + dt.timedelta(days=i), start + i * step) for i in range(n)]


def _as_arrays(series):
    dates = np.array([np.datetime64(p[0], "ns") for p in series])
    values = np.array([p[1] for p in series])
    return dates, values


class TestAsOfWindowBounds:
    def test_stored_band_equals_trailing_window_only(self, band_mod):
        """The band at row i must be the percentiles of (i - lookback, i] -- nothing after i."""
        series = _ramp_series(1200, 10.0, 40.0)
        dates, values = _as_arrays(series)
        lo, m_lo, med, m_hi, hi = band_mod._bands_for_windows(
            dates, values, band_mod.BAND_LOOKBACK_DAYS
        )

        for probe in (400, 700, 900, 1199):
            window_start = dates[probe] - np.timedelta64(band_mod.BAND_LOOKBACK_DAYS, "D")
            start = 0
            while start < probe and dates[start] <= window_start:
                start += 1
            expected = np.percentile(values[start : probe + 1], [10, 25, 50, 75, 90])
            got = np.array([lo[probe], m_lo[probe], med[probe], m_hi[probe], hi[probe]])
            assert np.allclose(got, expected, equal_nan=True), f"probe {probe}"

    def test_old_behaviour_would_have_failed_this(self, band_mod):
        """Pin the defect: a single full-slice percentile set is NOT the as-of band."""
        series = _ramp_series(1200, 10.0, 40.0)
        dates, values = _as_arrays(series)
        _, _, med, _, _ = band_mod._bands_for_windows(
            dates, values, band_mod.BAND_LOOKBACK_DAYS
        )
        full_slice_median = float(np.percentile(values, 50))
        assert not np.isclose(med[700], full_slice_median, atol=0.5)

    def test_flat_series_band_equals_the_level(self, band_mod):
        series = _ramp_series(400, 22.0, 22.0)
        dates, values = _as_arrays(series)
        lo, m_lo, med, m_hi, hi = band_mod._bands_for_windows(
            dates, values, band_mod.BAND_LOOKBACK_DAYS
        )
        i = 399
        assert lo[i] == m_lo[i] == med[i] == m_hi[i] == hi[i] == pytest.approx(22.0)


class TestInsufficientHistory:
    def test_early_rows_are_nan_not_a_fabricated_band(self, band_mod):
        series = _ramp_series(400, 10.0, 40.0)
        dates, values = _as_arrays(series)
        _, _, med, _, _ = band_mod._bands_for_windows(
            dates, values, band_mod.BAND_LOOKBACK_DAYS
        )
        # Row 0 has exactly one observation -- well under MIN_BAND_OBS -- so no band.
        assert np.isnan(med[0])
        assert not np.isnan(med[-1])

    def test_short_series_returns_none(self, band_mod):
        series = _ramp_series(band_mod.MIN_BAND_OBS - 1, 10.0, 40.0)
        dates, values = _as_arrays(series)
        assert band_mod._bands_for_windows(dates, values, band_mod.BAND_LOOKBACK_DAYS) is None

    def test_nan_does_not_leak_across_the_series(self, band_mod):
        series = _ramp_series(600, 10.0, 40.0)
        dates, values = _as_arrays(series)
        _, _, med, _, _ = band_mod._bands_for_windows(
            dates, values, band_mod.BAND_LOOKBACK_DAYS
        )
        nan_idx = np.where(np.isnan(med))[0]
        if nan_idx.size:
            # NaN rows can only be the warm-up prefix, never a hole in the middle.
            assert nan_idx.max() < np.where(~np.isnan(med))[0].min()


class TestConstants:
    def test_lookback_is_three_years(self, band_mod):
        assert band_mod.BAND_LOOKBACK_YEARS == 3
        assert band_mod.BAND_LOOKBACK_DAYS == 3 * 365

    def test_min_obs_preserved_from_original(self, band_mod):
        assert band_mod.MIN_BAND_OBS == 30
