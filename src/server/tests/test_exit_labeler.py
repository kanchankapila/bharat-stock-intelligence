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

    def test_corrupt_bar_does_not_produce_unbounded_excursion(self):
        # Live production case: RMCL's stock_ohlcv is frozen at open=2.0/high=200.0 across
        # 25+ consecutive sessions (a stale/corrupt feed that is_suspect never flagged). Fed
        # through here unclamped, entry=2.0 + high=200.0 produces mfe_pct=9900.0 -- an exact,
        # repeated sentinel-looking value that dominates exit_policy's holdout MAE whenever it
        # lands in a retrain's test slice (measured: ~150 such rows, |error| ~9895pp each).
        exc = compute_excursions(2.0, [(200.0, 1.9, 200.0)], atr=0.1)
        assert exc["mfe_pct"] == pytest.approx(50.0)
        assert exc["mae_pct"] == pytest.approx(-5.0)  # a genuine small move stays untouched

    def test_normal_bar_is_unaffected_by_the_clamp(self):
        bars = [(105, 99, 104), (110, 103, 108), (107, 95, 96)]
        exc = compute_excursions(self.ENTRY, bars, atr=2)
        assert exc["mfe_pct"] == pytest.approx(10.0)
        assert exc["mae_pct"] == pytest.approx(-5.0)


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


# ── Dynamic volatility-adjusted barriers ───────────────────────────────────────
from exit_labeler import (
    calculate_dynamic_triple_barrier_multipliers,
    compute_vol_rank,
    compute_trailing_atr_series,
    BASE_TB_K_UP_LO, BASE_TB_K_UP_HI,
    BASE_TB_K_DN_LO, BASE_TB_K_DN_HI,
    BASE_TB_COST_LO, BASE_TB_COST_HI,
)


class TestDynamicBarrierMultipliers:
    def test_low_vol_regime_tightens_all(self):
        k_up, k_dn, cost = calculate_dynamic_triple_barrier_multipliers(0.0)
        assert k_up == pytest.approx(BASE_TB_K_UP_LO)      # 1.0x ATR
        assert k_dn == pytest.approx(BASE_TB_K_DN_LO)      # 0.5x ATR
        assert cost == pytest.approx(BASE_TB_COST_LO)      # 0.10x ATR

    def test_high_vol_regime_matches_legacy_fixed_scheme(self):
        k_up, k_dn, cost = calculate_dynamic_triple_barrier_multipliers(1.0)
        assert k_up == pytest.approx(BASE_TB_K_UP_HI)      # 2.0x ATR (legacy)
        assert k_dn == pytest.approx(BASE_TB_K_DN_HI)      # 1.0x ATR (legacy)
        assert cost == pytest.approx(BASE_TB_COST_LO + (BASE_TB_COST_HI - BASE_TB_COST_LO))

    def test_midpoint_is_halfway(self):
        k_up, k_dn, cost = calculate_dynamic_triple_barrier_multipliers(0.5)
        assert k_up == pytest.approx((BASE_TB_K_UP_LO + BASE_TB_K_UP_HI) / 2)
        assert k_dn == pytest.approx((BASE_TB_K_DN_LO + BASE_TB_K_DN_HI) / 2)
        assert cost == pytest.approx(0.15)  # the legacy ±0.15 ATR cost band

    def test_none_reproduces_legacy_scheme(self):
        k_up, k_dn, cost = calculate_dynamic_triple_barrier_multipliers(None)
        assert k_up == pytest.approx(2.0)
        assert k_dn == pytest.approx(1.0)
        assert cost == pytest.approx(0.15)

    def test_out_of_range_input_is_clamped(self):
        k_up_lo, _, _ = calculate_dynamic_triple_barrier_multipliers(-5.0)
        k_up_hi, _, _ = calculate_dynamic_triple_barrier_multipliers(5.0)
        assert k_up_lo == pytest.approx(BASE_TB_K_UP_LO)
        assert k_up_hi == pytest.approx(BASE_TB_K_UP_HI)

    def test_reward_risk_ratio_never_degrades_below_legacy(self):
        # The 2:1 asymmetric profile is the strategy's edge; the dynamic scheme must keep
        # upper ≥ 2·|lower| in every regime.
        for t in (0.0, 0.25, 0.5, 0.75, 1.0):
            k_up, k_dn, _ = calculate_dynamic_triple_barrier_multipliers(t)
            assert k_up >= 2.0 * k_dn - 1e-9


class TestComputeVolRank:
    def _bars_with_constant_atr(self, atr_value, n=40):
        """n ascending bars each producing exactly atr_value of true range."""
        bars = [(10.0, 10.0, 10.0)]                    # seed bar (prev_close source)
        price = 10.0
        for _ in range(n - 1):
            high = price + atr_value
            low = price
            close = price                              # TR = high−low = atr_value exactly
            bars.append((high, low, close))
        return bars

    def test_insufficient_history_returns_neutral_half(self):
        assert compute_vol_rank([]) == 0.5
        assert compute_vol_rank([(10, 9, 9.5)]) == 0.5

    def test_flat_volatility_ranks_in_range(self):
        bars = self._bars_with_constant_atr(1.0)
        vr = compute_vol_rank(bars)
        assert 0.0 <= vr <= 1.0

    def test_spike_in_vol_ranks_high(self):
        # 14 calm sessions (TR 1.0), then 22 storm sessions (TR 5.0) ending at entry:
        # entry-time ATR = 5.0, trailing ATR history mostly 1.0–5.0 → rank pinned at the top.
        bars = [(10.0, 10.0, 10.0)]
        for _ in range(14):
            bars.append((11.0, 10.0, 10.0))
        for _ in range(22):
            bars.append((15.0, 10.0, 10.0))
        vr = compute_vol_rank(bars)
        assert vr > 0.8, f"vol spike should rank high, got {vr}"

    def test_calm_after_storm_ranks_low(self):
        # Mirror image: 22 storm sessions, then 14 calm sessions ending at entry.
        # Entry-time ATR = 1.0 while the trailing history is storm-dominated → rank 0.
        bars = [(10.0, 10.0, 10.0)]
        for _ in range(22):
            bars.append((15.0, 10.0, 10.0))
        for _ in range(14):
            bars.append((11.0, 10.0, 10.0))
        vr = compute_vol_rank(bars)
        assert vr < 0.2, f"vol calm should rank low, got {vr}"

    def test_is_leak_free(self):
        # The ATR series' last element must equal compute_atr(prior_bars) — i.e. the
        # entry-time ATR computed only from bars at or before the signal date.
        bars = self._bars_with_constant_atr(2.0, n=40)
        series = compute_trailing_atr_series(bars)
        assert series, "expected a non-empty ATR series"
        assert series[-1] == pytest.approx(compute_atr(bars))


class TestVolRankBarrierIntegration:
    """vol_rank must change the label in exactly the direction the audit intends."""

    def test_low_vol_regime_lowers_the_win_threshold(self):
        # atr_pct=1.0, vol_rank=0 → upper barrier = 1.0x ATR = 1.0%. mfe 1.2 ≥ 1.0 → WIN,
        # whereas the legacy fixed scheme (2.0x) would leave it to the time-barrier rule.
        label = triple_barrier_label(mfe_pct=1.2, mae_pct=-0.3, mfe_before_mae=1,
                                     horizon_close_pct=0.05, atr_pct=1.0, vol_rank=0.0)
        assert label == 1

    def test_high_vol_regime_keeps_the_legacy_threshold(self):
        # Same excursion, vol_rank=1 → upper barrier = 2.0% → not touched → time-barrier
        # rule: horizon close +0.05 is INSIDE the cost band (0.2) → NEUTRAL.
        label = triple_barrier_label(mfe_pct=1.2, mae_pct=-0.3, mfe_before_mae=1,
                                     horizon_close_pct=0.05, atr_pct=1.0, vol_rank=1.0)
        assert label is None

    def test_wide_cost_band_in_high_vol_neutralizes_noise(self):
        # atr 2.0, vol_rank=1 → cost band ±0.4%; close +0.3% → neutral (not a win).
        label = triple_barrier_label(mfe_pct=0.5, mae_pct=-0.3, mfe_before_mae=1,
                                     horizon_close_pct=0.3, atr_pct=2.0, vol_rank=1.0)
        assert label is None
        # Same close, vol_rank=0 → cost band ±0.2%; close +0.3% clears it → win.
        label = triple_barrier_label(mfe_pct=0.5, mae_pct=-0.3, mfe_before_mae=1,
                                     horizon_close_pct=0.3, atr_pct=2.0, vol_rank=0.0)
        assert label == 1

    def test_tight_lower_barrier_in_low_vol_gives_earlier_loss_signal(self):
        # atr 2.0: mae −1.2 hits the vol_rank=0 lower barrier (−1.0) but not the legacy
        # vol_rank=1 one (−2.0).
        assert triple_barrier_label(mfe_pct=0.5, mae_pct=-1.2, mfe_before_mae=0,
                                    horizon_close_pct=-0.3, atr_pct=2.0, vol_rank=0.0) == 0
        # high-vol: lower barrier −2.0 untouched → time-barrier; −0.3 within ±0.4 band → None
        assert triple_barrier_label(mfe_pct=0.5, mae_pct=-1.2, mfe_before_mae=0,
                                    horizon_close_pct=-0.3, atr_pct=2.0, vol_rank=1.0) is None

    def test_excursions_thread_vol_rank_and_echo_it(self):
        bars = [(105, 99, 104), (110, 103, 108), (107, 95, 96)]
        exc = compute_excursions(100.0, bars, atr=2, vol_rank=0.37)
        assert exc["vol_rank"] == pytest.approx(0.37)
        assert "tb_label" in exc  # label computed without error

    def test_excursions_default_vol_rank_is_none(self):
        bars = [(105, 99, 104), (110, 103, 108), (107, 95, 96)]
        exc = compute_excursions(100.0, bars, atr=2)
        assert exc["vol_rank"] is None
