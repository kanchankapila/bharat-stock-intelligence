"""Regression tests for ohlcv_adjust.py.

Every case below is a real failure mode that actually occurred while building this module,
against real NSE data. The detection method was WRONG in its first form -- it assumed NSE's
bhavcopy PREV_CLOSE was ex-date-adjusted (it is not), which made every real split invisible
while surfacing clusters of artifacts. That was caught only by checking a known split, so the
known-split cases are pinned here and in the live_datasource test.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ohlcv_adjust as oa


# (date, prev_close, open, high, low, close) -- real rows from nse_universe_history.
NESTLE_SPLIT = ("2024-01-05", 27116.4, 2754.0, 2754.0, 2642.45, 2666.4)   # 1:10
IRCTC_SPLIT = ("2021-10-28", 4130.15, 817.0, 983.0, 810.0, 913.5)         # 1:5, +10.6% on the day
NORMAL_DAY = ("2024-01-04", 26635.2, 26700.0, 27200.0, 26500.0, 27116.4)


class TestKnownSplits:
    def test_nestle_one_for_ten(self):
        acc, rej = oa.detect_adjustment_events([NESTLE_SPLIT])
        assert acc == [("2024-01-05", 0.1)], f"expected 1:10, got {acc} / rejected {rej}"

    def test_irctc_one_for_five_despite_a_big_real_move(self):
        """close/prev_close is 0.2212 here because IRCTC rose 10.6% on its ex-date -- far
        outside any safe snap tolerance for 1/5. open/prev_close is 0.1978. Snapping off the
        OPEN is what makes this detectable at all."""
        acc, _ = oa.detect_adjustment_events([IRCTC_SPLIT])
        assert acc == [("2021-10-28", 0.2)]

    def test_ordinary_day_yields_nothing(self):
        acc, rej = oa.detect_adjustment_events([NORMAL_DAY])
        assert acc == [] and rej == []


class TestFalsePositiveGuards:
    def test_circuit_locked_day_is_not_a_split(self):
        """A stock locked at its +20% band trades at ONE price all day, and 1.20 is also a
        plausible 6:5 consolidation ratio. Before this guard, 1.2 was the single most common
        detected 'ratio' in the entire history (99 events)."""
        locked = ("2024-05-05", 100.0, 120.0, 120.0, 120.0, 120.0)
        acc, rej = oa.detect_adjustment_events([locked])
        assert acc == []
        assert rej[0][2] == 'circuit_locked_zero_range'

    def test_big_real_crash_is_not_a_split(self):
        """AASTHA closed at exactly 0.8000 of its previous close -- a textbook 1:4 bonus ratio
        -- but its HIGH was 1.0334x, i.e. the session still traded on the old basis."""
        crash = ("2026-07-22", 100.0, 99.0, 103.34, 79.0, 80.0)
        acc, rej = oa.detect_adjustment_events([crash])
        assert acc == []
        assert rej[0][2] == 'range_touches_old_basis'

    def test_penny_stock_rounding_is_refused(self):
        """BLUECHIP moved 0.90 -> 2.15; at that price the tick alone manufactures ratios."""
        penny = ("2023-08-25", 0.90, 2.10, 2.20, 2.05, 2.15)
        acc, rej = oa.detect_adjustment_events([penny])
        assert acc == []
        assert rej[0][2] == 'below_price_floor'

    def test_unclean_ratio_is_refused_not_guessed(self):
        """0.365 sits in a genuinely sparse part of the ratio grid (nearest are 1/3 and 2/5,
        both ~9% away). Note the grid is DENSE in places -- 0.613 legitimately snaps to 5/8,
        a real 3:5 bonus -- so ratio-snapping is a weak filter. The range and circuit-lock
        tests above are the load-bearing guards; this one only cleans up the number."""
        odd = ("2024-01-05", 100.0, 36.5, 37.0, 36.0, 36.5)
        acc, rej = oa.detect_adjustment_events([odd])
        assert acc == []
        assert rej[0][2] == 'not_a_clean_ratio'

    def test_a_trading_gap_cannot_fabricate_an_event(self):
        """The whole reason detection is within-row: BEARDSELL's rows jump five weeks, and the
        old cross-row method read that accumulated move as a 0.8382 'split'."""
        rows = [("2023-07-21", 33.0, 32.4, 32.6, 32.2, 32.45),
                ("2023-08-25", 27.2, 27.45, 27.7, 27.45, 27.7)]
        acc, _ = oa.detect_adjustment_events(rows)
        assert acc == []


class TestSnapping:
    def test_snaps_to_the_clean_ratio_not_the_raw_quotient(self):
        assert oa.snap_to_ratio(0.1016) == 0.1
        assert oa.snap_to_ratio(0.1978) == 0.2

    def test_refuses_when_nothing_clean_is_near(self):
        # 0.365: nearest plausible ratios are 1/3 (9.5% away) and 2/5 (8.8% away).
        assert oa.snap_to_ratio(0.365) is None

    def test_ratios_inside_the_deadband_are_not_candidates(self):
        for r in oa.PLAUSIBLE:
            assert abs(r - 1.0) > oa.DEADBAND


class TestCumulativeFactors:
    def test_bars_before_an_event_are_scaled_and_later_bars_are_not(self):
        dates = ["2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"]
        m = oa.cumulative_factor_map([("2024-01-05", 0.1)], dates)
        assert m["2024-01-03"] == pytest.approx(0.1)
        assert m["2024-01-04"] == pytest.approx(0.1)
        # The ex-date bar is ALREADY on the new basis -- adjusting it again would double-count.
        assert m["2024-01-05"] == pytest.approx(1.0)
        assert m["2024-01-08"] == pytest.approx(1.0)

    def test_multiple_events_compound(self):
        dates = ["2021-01-01", "2023-01-01", "2025-01-01"]
        m = oa.cumulative_factor_map([("2022-01-01", 0.5), ("2024-01-01", 0.1)], dates)
        assert m["2021-01-01"] == pytest.approx(0.05)
        assert m["2023-01-01"] == pytest.approx(0.1)
        assert m["2025-01-01"] == pytest.approx(1.0)

    def test_most_recent_bars_are_never_rescaled(self):
        """Today's prices must always match the exchange -- back-adjustment only moves history."""
        dates = ["2024-01-01", "2026-07-31"]
        m = oa.cumulative_factor_map([("2025-01-01", 0.5)], dates)
        assert m["2026-07-31"] == pytest.approx(1.0)
