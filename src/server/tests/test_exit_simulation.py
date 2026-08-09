import sys, os
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Pure long-trade exit simulator (#2): intraday target capture + 50% scale-out +
# ATR chandelier trailing stop + hard initial stop + time exit. No DB.
from outcome_resolver import simulate_exit, SCALE_OUT_FRAC, CHANDELIER_ATR_MULT  # noqa: E402

# Reference setup: entry 100, ATR 2 -> initial stop 97, target 105, chandelier = high-6.
ENTRY, ATR, STOP, TARGET = 100.0, 2.0, 97.0, 105.0


def sim(bars, target=TARGET, stop=STOP, atr=ATR):
    return simulate_exit(bars, entry=ENTRY, initial_stop=stop, target=target, atr=atr)


def test_target_capture_then_fade_books_partial_not_faded_close():
    # Runs to target day 1, fades back; trailing stop takes the remainder at a profit.
    # Old logic booked the horizon close (~0%); we should capture ~2.5%.
    bars = [
        ('d1', 106, 100, 104),   # high>=105 -> book 50% at 105; highest=106
        ('d2', 104, 101, 102),   # chandelier = 106-6 = 100; low 101 holds
        ('d3', 103,  99, 100),   # low 99 <= trailing stop 100 -> exit remainder at 100
    ]
    exit_date, exit_price, reason, gross, mfe, mae = sim(bars)
    assert reason == 'TRAILING_STOP'
    assert gross == pytest.approx(2.5, abs=0.01)   # 0.5*5% + 0.5*0%
    assert mfe == pytest.approx(6.0, abs=0.01)      # highest 106 vs entry 100
    assert mae == pytest.approx(-1.0, abs=0.01)     # lowest 99 vs entry 100 (day 3's low)


def test_winner_runs_then_time_exits_remainder_higher():
    bars = [
        ('d1', 106, 100, 105),   # partial at 105
        ('d2', 110, 104, 109),
        ('d3', 112, 108, 111),   # no stop hit; remainder time-exits at 111
    ]
    _, _, reason, gross, mfe, mae = sim(bars)
    assert reason == 'TIME_EXIT_PARTIAL'
    assert gross == pytest.approx(0.5 * 5 + 0.5 * 11, abs=0.01)   # 8.0
    assert mfe == pytest.approx(12.0, abs=0.01)     # highest 112 vs entry 100
    assert mae == pytest.approx(0.0, abs=0.01)      # lowest low across all bars is 100 (day 1)


def test_hard_initial_stop_on_immediate_drop():
    bars = [('d1', 100.5, 96, 96.5)]   # never reached target; low breaches initial 97
    _, exit_price, reason, gross, mfe, mae = sim(bars)
    assert reason == 'STOP_LOSS'
    assert exit_price == 97.0
    assert gross == pytest.approx(-3.0, abs=0.01)
    assert mfe == pytest.approx(0.5, abs=0.01)      # highest 100.5 vs entry 100
    assert mae == pytest.approx(-4.0, abs=0.01)     # lowest 96 vs entry 100


def test_time_exit_when_no_barrier_touched():
    bars = [
        ('d1', 102, 99, 101),
        ('d2', 103, 100, 102),
        ('d3', 104, 101, 103),   # never hit 105 or 97 -> time exit at last close 103
    ]
    _, _, reason, gross, mfe, mae = sim(bars)
    assert reason == 'TIME_EXIT'
    assert gross == pytest.approx(3.0, abs=0.01)
    assert mfe == pytest.approx(4.0, abs=0.01)      # highest 104 vs entry 100
    assert mae == pytest.approx(-1.0, abs=0.01)     # lowest 99 vs entry 100


def test_stop_checked_before_target_within_a_bar():
    # One bar straddles both barriers; conservative labeling assumes the stop first.
    bars = [('d1', 106, 96, 100)]
    _, _, reason, gross, mfe, mae = sim(bars)
    assert reason == 'STOP_LOSS'
    assert gross == pytest.approx(-3.0, abs=0.01)
    # mfe still reflects the bar's real high even though the stop fired -- MFE/MAE describe
    # the price PATH, independent of which barrier the trade actually exited through.
    assert mfe == pytest.approx(6.0, abs=0.01)
    assert mae == pytest.approx(-4.0, abs=0.01)


def test_trailing_stop_without_target():
    # No target (e.g. screener signal) -> no scale-out, but trailing still locks gains.
    bars = [
        ('d1', 110, 100, 108),   # highest 110
        ('d2', 105, 100, 102),   # chandelier 110-6=104; low 100 <= 104 -> exit at 104
    ]
    _, exit_price, reason, gross, mfe, mae = sim(bars, target=None)
    assert reason == 'TRAILING_STOP'
    assert exit_price == 104.0
    assert gross == pytest.approx(4.0, abs=0.01)
    assert mfe == pytest.approx(10.0, abs=0.01)     # highest 110 vs entry 100
    assert mae == pytest.approx(0.0, abs=0.01)      # lowest low across bars is 100


def test_zero_atr_disables_trailing():
    bars = [
        ('d1', 110, 100, 108),
        ('d2', 105, 98, 99),     # atr 0 -> no chandelier; low 98 > initial 97 -> survives
    ]
    _, _, reason, gross, mfe, mae = sim(bars, target=None, atr=0.0)
    assert reason == 'TIME_EXIT'
    assert gross == pytest.approx(-1.0, abs=0.01)   # gives back to close 99
    assert mfe == pytest.approx(10.0, abs=0.01)     # highest 110 vs entry 100
    assert mae == pytest.approx(-2.0, abs=0.01)     # lowest 98 vs entry 100


def test_empty_bars_returns_pending_with_none_mfe_mae():
    exit_date, exit_price, reason, gross, mfe, mae = simulate_exit(
        [], entry=ENTRY, initial_stop=STOP, target=TARGET, atr=ATR)
    assert reason == 'PENDING'
    assert exit_date is None and exit_price is None and gross is None
    assert mfe is None and mae is None


def test_constants_are_sane():
    assert 0 < SCALE_OUT_FRAC < 1
    assert CHANDELIER_ATR_MULT >= 2
