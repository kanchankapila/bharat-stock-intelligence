"""
Tests for exit_labeler — path-based excursion + trailing-exit labels.
Pure-function coverage of compute_atr and compute_excursions (no DB).
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from exit_labeler import compute_atr, compute_excursions


class TestComputeATR:
    def test_too_few_bars_returns_zero(self):
        assert compute_atr([]) == 0.0
        assert compute_atr([(10, 9, 9.5)]) == 0.0

    def test_true_range_uses_prev_close(self):
        # bar2 TR = max(high-low=1, |high-prevclose|=1.5, |low-prevclose|=0.5) = 1.5
        atr = compute_atr([(10, 9, 9.5), (11, 10, 10.5)])
        assert atr == pytest.approx(1.5)


class TestComputeExcursions:
    ENTRY = 100.0

    def test_empty_or_invalid_returns_empty(self):
        assert compute_excursions(self.ENTRY, [], atr=2) == {}
        assert compute_excursions(0, [(105, 99, 104)], atr=2) == {}

    def test_mfe_mae_magnitude_and_timing(self):
        bars = [(105, 99, 104), (110, 103, 108), (107, 95, 96)]
        exc = compute_excursions(self.ENTRY, bars, atr=2)
        assert exc["mfe_pct"] == pytest.approx(10.0)   # peak +10% on day 2
        assert exc["days_to_mfe"] == 2
        assert exc["mae_pct"] == pytest.approx(-5.0)    # trough -5% on day 3
        assert exc["days_to_mae"] == 3
        assert exc["mfe_before_mae"] == 1               # gain (d2) preceded pain (d3)
        assert exc["horizon_close_pct"] == pytest.approx(-4.0)

    def test_chandelier_trailing_exit_fires(self):
        bars = [(105, 99, 104), (110, 103, 108), (107, 95, 96)]
        exc = compute_excursions(self.ENTRY, bars, atr=2)   # stop = highest_high − 6
        # day3 highest_high=110 → stop 104; low 95 ≤ 104 → exit at the stop, day 3
        assert exc["trail_exit_day"] == 3
        assert exc["trail_exit_pct"] == pytest.approx(4.0)

    def test_no_stop_hit_holds_to_horizon(self):
        bars = [(102, 101, 101.5), (104, 103, 103.5), (106, 105, 105.5)]
        exc = compute_excursions(self.ENTRY, bars, atr=2)
        assert exc["trail_exit_day"] is None
        assert exc["trail_exit_pct"] == pytest.approx(exc["horizon_close_pct"])
        assert exc["trail_exit_pct"] == pytest.approx(5.5)

    def test_zero_atr_disables_trailing(self):
        bars = [(105, 90, 104), (110, 103, 108)]
        exc = compute_excursions(self.ENTRY, bars, atr=0)   # ATR unknown → no trailing stop
        assert exc["trail_exit_day"] is None
        assert exc["trail_exit_pct"] == pytest.approx(exc["horizon_close_pct"])

    def test_gap_through_fills_at_stop(self):
        bars = [(100, 80, 82)]                              # gaps straight through the stop
        exc = compute_excursions(self.ENTRY, bars, atr=2)   # stop = 100 − 6 = 94
        assert exc["trail_exit_day"] == 1
        assert exc["trail_exit_pct"] == pytest.approx(-6.0)  # filled at 94, not at the 80 low


# ── Triple-barrier label (López de Prado, vol-scaled, asymmetric) ──────────────
from exit_labeler import triple_barrier_label


class TestTripleBarrierLabel:
    K_UP, K_DN = 2.0, 1.0  # upper = +2·atr%, lower = −1·atr%
    COST = 0.4

    def _lab(self, **kw):
        base = dict(mfe_pct=0.0, mae_pct=0.0, mfe_before_mae=1,
                    horizon_close_pct=0.0, atr_pct=1.0,
                    k_up=self.K_UP, k_dn=self.K_DN, cost_frac=self.COST)
        base.update(kw)
        return triple_barrier_label(**base)

    def test_upper_barrier_only_is_win(self):
        # mfe 5 ≥ upper(2); mae -0.5 not ≤ lower(-1)
        assert self._lab(mfe_pct=5.0, mae_pct=-0.5) == 1

    def test_lower_barrier_only_is_loss(self):
        # mae -3 ≤ lower(-1); mfe 0.5 not ≥ upper(2)
        assert self._lab(mfe_pct=0.5, mae_pct=-3.0) == 0

    def test_both_touched_mfe_first_is_win(self):
        assert self._lab(mfe_pct=3.0, mae_pct=-2.0, mfe_before_mae=1) == 1

    def test_both_touched_mae_first_is_loss(self):
        assert self._lab(mfe_pct=3.0, mae_pct=-2.0, mfe_before_mae=0) == 0

    def test_time_barrier_positive_close_is_win(self):
        # neither barrier touched; horizon close +1.5 beats cost band
        assert self._lab(mfe_pct=1.0, mae_pct=-0.5, horizon_close_pct=1.5) == 1

    def test_time_barrier_within_cost_band_is_neutral(self):
        assert self._lab(mfe_pct=0.3, mae_pct=-0.3, horizon_close_pct=0.2) is None

    def test_missing_vol_falls_back_to_net_close_sign(self):
        assert self._lab(atr_pct=0.0, horizon_close_pct=2.0) == 1
        assert self._lab(atr_pct=0.0, horizon_close_pct=-2.0) == 0
        assert self._lab(atr_pct=0.0, horizon_close_pct=0.1) is None

    def test_none_horizon_close_is_neutral(self):
        assert self._lab(horizon_close_pct=None, atr_pct=0.0) is None

    def test_asymmetric_downside_barrier_is_tighter(self):
        # mae -1.2 ≤ lower(-1) loses, even though upside barrier (+2) is untouched
        assert self._lab(mfe_pct=1.5, mae_pct=-1.2) == 0
