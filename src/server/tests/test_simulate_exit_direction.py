"""AF-20261008-10: `simulate_exit` graded every signal as a LONG, whatever its direction.

Its own docstring reads "Bar-by-bar long-trade exit simulation", and `_resolve_unified_batch`
called it for every `unified_signals` row regardless of direction. A short signal has its target
BELOW and its stop ABOVE entry, so the long logic read both levels inverted. Measured live
2026-10-08 on `unified_signal_outcomes`:

    signal_type  outcome      n         avg return_pct
    Bullish      STOP_LOSS   32,253        -5.866     <- correct for a stopped-out long
    Bearish      STOP_LOSS  115,731        +4.427     <- a LOSS recorded as a +4.4% gain

`return_pct` tracked the raw price move to within 0.3pp in every bucket: no direction adjustment
anywhere in the column.

`direction` defaults to 'long' so every existing caller (the `signal_outcomes` technical path and
the `recommendation_log` path, both genuinely long-only) is byte-for-byte unchanged.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from outcome_resolver import simulate_exit  # noqa: E402


def _bars(rows):
    """rows: (date, high, low, close)"""
    return list(rows)


class TestLongBehaviourIsUnchanged:
    """Regression floor: the long path must not move at all."""

    def test_long_stop_loss(self):
        d, px, reason, gross, mfe, mae = simulate_exit(
            _bars([('d1', 101, 85, 88)]), entry=100.0, initial_stop=90.0, target=120.0, atr=0)
        assert reason == 'STOP_LOSS' and px == 90.0
        assert round(gross, 4) == -10.0

    def test_long_time_exit(self):
        d, px, reason, gross, mfe, mae = simulate_exit(
            _bars([('d1', 105, 99, 104)]), entry=100.0, initial_stop=90.0, target=120.0, atr=0)
        assert reason == 'TIME_EXIT' and px == 104
        assert round(gross, 4) == 4.0

    def test_long_target_partial_then_time(self):
        _, _, reason, gross, _, _ = simulate_exit(
            _bars([('d1', 125, 99, 122)]), entry=100.0, initial_stop=90.0, target=120.0, atr=0)
        assert reason == 'TIME_EXIT_PARTIAL'
        # 50% booked at +20%, remainder exits at +22%
        assert round(gross, 4) == round(0.5 * 20.0 + 0.5 * 22.0, 4)


class TestShortIsMirrored:
    """A short profits when price FALLS: stop above entry, target below."""

    def test_short_stopped_out_is_a_LOSS_not_a_gain(self):
        """The defect, in one assertion. Price rose from 100 to the 110 stop: that is a 10% LOSS
        for a short. The long-only code returned +10%."""
        d, px, reason, gross, mfe, mae = simulate_exit(
            _bars([('d1', 115, 99, 112)]), entry=100.0, initial_stop=110.0, target=80.0,
            atr=0, direction='short')
        assert reason == 'STOP_LOSS'
        assert px == 110.0
        assert round(gross, 4) == -10.0, 'a stopped-out short must book a loss'

    def test_short_target_hit_is_a_gain(self):
        _, _, reason, gross, _, _ = simulate_exit(
            _bars([('d1', 101, 75, 78)]), entry=100.0, initial_stop=110.0, target=80.0,
            atr=0, direction='short')
        assert reason == 'TIME_EXIT_PARTIAL'
        # 50% booked at the 80 target (+20% for a short), remainder exits at 78 (+22%)
        assert round(gross, 4) == round(0.5 * 20.0 + 0.5 * 22.0, 4)

    def test_short_time_exit_prices_the_fall_as_profit(self):
        _, px, reason, gross, _, _ = simulate_exit(
            _bars([('d1', 101, 95, 96)]), entry=100.0, initial_stop=110.0, target=80.0,
            atr=0, direction='short')
        assert reason == 'TIME_EXIT' and px == 96
        assert round(gross, 4) == 4.0, 'price fell 4%, which is +4% to a short'

    def test_short_mfe_and_mae_follow_the_direction(self):
        _, _, _, _, mfe, mae = simulate_exit(
            _bars([('d1', 104, 90, 96)]), entry=100.0, initial_stop=110.0, target=80.0,
            atr=0, direction='short')
        assert round(mfe, 4) == 10.0, 'the favorable excursion for a short is the LOW (90 -> +10%)'
        assert round(mae, 4) == -4.0, 'the adverse excursion is the HIGH (104 -> -4%)'

    def test_short_chandelier_trails_DOWN(self):
        """After a favorable move the trailing stop must ratchet DOWN for a short, never up, and
        never above the initial stop."""
        bars = _bars([('d1', 99, 80, 82), ('d2', 95, 90, 94)])
        d, px, reason, gross, _, _ = simulate_exit(
            bars, entry=100.0, initial_stop=110.0, target=50.0, atr=5.0, direction='short')
        # lowest after d1 is 80; chandelier = 80 + 3*5 = 95, tighter than the 110 initial stop.
        # d2's high of 95 touches it.
        assert reason == 'TRAILING_STOP'
        assert px == 95.0
        assert round(gross, 4) == 5.0, 'exited at 95 from a short at 100 = +5%'

    def test_short_stop_is_tested_before_target_within_a_bar(self):
        """Same conservative rule as the long path: assume the adverse move came first."""
        _, _, reason, gross, _, _ = simulate_exit(
            _bars([('d1', 115, 75, 90)]), entry=100.0, initial_stop=110.0, target=80.0,
            atr=0, direction='short')
        assert reason == 'STOP_LOSS'
        assert round(gross, 4) == -10.0


class TestDirectionDefaultsToLong:
    def test_omitted_direction_is_long(self):
        a = simulate_exit(_bars([('d1', 101, 85, 88)]), 100.0, 90.0, 120.0, 0)
        b = simulate_exit(_bars([('d1', 101, 85, 88)]), 100.0, 90.0, 120.0, 0, direction='long')
        assert a == b

    def test_unified_resolver_passes_the_signal_direction(self):
        """The fix is only live if the caller supplies it -- an optional argument nobody passes is
        the registered-but-never-delivered class. Pinned at the call site."""
        import inspect
        import outcome_resolver
        src = inspect.getsource(outcome_resolver._resolve_unified_batch)
        assert 'direction=' in src, \
            '_resolve_unified_batch must pass the signal direction to simulate_exit'
