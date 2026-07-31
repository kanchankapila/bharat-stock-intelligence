"""
Regression tests for intraday_outcome_resolver.py.

The module was rewritten on 2026-07-31 after the intraday audit found it graded intraday
signals against the DAILY stock_ohlcv bar. That bar's open/high/low span 09:15 to the close,
so they include price action from before the signal existed:

  * comparing the daily OPEN to a target derived from a price reached hours later manufactured
    "gap" exits that were never trades -- live, 122 STOP_GAP rows averaging -9.54% (one at
    -100.04%) and 42 TARGET_GAP rows averaging +5.21%;
  * high/low covered the whole session, so a stop or target could register as hit by a move
    that happened before entry.

These tests pin the corrected behaviour: entry at the first bar opening strictly after
cycle_at, exits scanned only on later bars, and no gap semantics at all.
"""

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import intraday_outcome_resolver as ior

_IST = timezone(timedelta(hours=5, minutes=30))


def _bars(*ohlc):
    """[(open, high, low, close), ...] -- the shape paper_trade consumes."""
    return list(ohlc)


class TestPaperTradeUsesOnlyPostEntryBars:
    def test_entry_bar_cannot_trigger_its_own_stop(self):
        """bars[0] is the bar whose OPEN filled the order. Its own high/low describe a path
        we cannot resolve relative to the fill, so it must not decide the outcome -- this is
        the intrabar equivalent of the whole-day look-ahead the rewrite removed."""
        # entry bar dips far below the stop, later bars are flat at the entry price
        bars = _bars((100.0, 100.0, 50.0, 100.0), (100.0, 100.0, 100.0, 100.0))
        _exit, reason, _pnl, _out = ior.paper_trade(100.0, 105.0, 95.0, bars)
        assert reason == "CLOSE"

    def test_stop_on_a_later_bar_is_honoured(self):
        bars = _bars((100.0, 101.0, 99.0, 100.0), (100.0, 100.0, 94.0, 96.0))
        exit_p, reason, pnl, outcome = ior.paper_trade(100.0, 105.0, 95.0, bars)
        assert reason == "STOP"
        assert exit_p == pytest.approx(95.0)
        assert outcome == "LOSS" and pnl < 0

    def test_target_on_a_later_bar_is_honoured(self):
        bars = _bars((100.0, 101.0, 99.0, 100.0), (100.0, 106.0, 100.0, 105.5))
        exit_p, reason, _pnl, outcome = ior.paper_trade(100.0, 105.0, 95.0, bars)
        assert reason == "TARGET"
        assert exit_p == pytest.approx(105.0)
        assert outcome == "WIN"

    def test_stop_wins_ties_within_one_bar(self):
        """Within a single 15m bar the path is unknown; assuming the stop filled first is the
        conservative choice and must not silently become a win."""
        bars = _bars((100.0, 100.0, 100.0, 100.0), (100.0, 110.0, 90.0, 100.0))
        _exit, reason, _pnl, _out = ior.paper_trade(100.0, 105.0, 95.0, bars)
        assert reason == "STOP"

    def test_first_touch_wins_across_bars(self):
        """A stop touched on bar 1 ends the trade -- a later target must not overwrite it."""
        bars = _bars((100.0, 100.0, 100.0, 100.0),
                     (100.0, 101.0, 94.0, 95.0),
                     (95.0, 120.0, 95.0, 118.0))
        _exit, reason, _pnl, _out = ior.paper_trade(100.0, 105.0, 95.0, bars)
        assert reason == "STOP"

    def test_no_touch_exits_at_last_bar_close(self):
        bars = _bars((100.0, 100.0, 100.0, 100.0), (100.0, 102.0, 99.0, 101.0))
        exit_p, reason, _pnl, _out = ior.paper_trade(100.0, 105.0, 95.0, bars)
        assert reason == "CLOSE" and exit_p == pytest.approx(101.0)

    def test_no_gap_exit_reasons_are_ever_produced(self):
        """There is no such thing as a gap on an intraday signal: the position opens and
        closes inside one session. STOP_GAP/TARGET_GAP were artifacts of comparing the signal
        to the DAILY open."""
        for bars in (_bars((100.0, 100.0, 20.0, 30.0), (30.0, 31.0, 29.0, 30.0)),
                     _bars((100.0, 400.0, 100.0, 390.0), (390.0, 391.0, 389.0, 390.0))):
            _e, reason, _p, _o = ior.paper_trade(100.0, 105.0, 95.0, bars)
            assert reason in {"STOP", "TARGET", "CLOSE"}
            assert "GAP" not in reason

    def test_costs_are_charged(self):
        """A flat round trip must lose exactly the modelled cost, not break even."""
        bars = _bars((100.0, 100.0, 100.0, 100.0), (100.0, 100.0, 100.0, 100.0))
        _e, _r, pnl, outcome = ior.paper_trade(100.0, 105.0, 95.0, bars)
        expected = -(ior.INTRADAY_SLIPPAGE_BPS / 100.0) - (2 * ior.INTRADAY_COMMISSION_BPS / 100.0)
        assert pnl == pytest.approx(expected, abs=0.01)
        assert outcome == "LOSS"

    def test_returns_nones_for_missing_inputs(self):
        assert ior.paper_trade(0, 1, 1, _bars((1.0, 1.0, 1.0, 1.0))) == (None, None, None, None)
        assert ior.paper_trade(100.0, 105.0, 95.0, []) == (None, None, None, None)


class TestTimestampNormalisation:
    def test_naive_text_is_treated_as_utc(self):
        ts = ior._parse_ts("2026-07-30T03:57:45.409921")
        assert ts is not None and ts.tzinfo is not None
        assert ts.hour == 3

    def test_aware_datetime_is_preserved(self):
        src = datetime(2026, 7, 30, 9, 30, tzinfo=_IST)
        assert ior._parse_ts(src) == src

    def test_garbage_returns_none(self):
        assert ior._parse_ts("not-a-timestamp") is None
        assert ior._parse_ts(None) is None


class TestOffGridBarsRejected:
    """Both vendors append the current in-progress quote stamped at request time rather than
    on the bar grid (zero volume, open==high==low==close). intraday_fetcher.py drops these at
    write time now, but ~2M already exist in the compressed hypertable."""

    def test_grid_bar_accepted(self):
        assert ior._on_grid(datetime(2026, 7, 30, 9, 30, tzinfo=_IST))
        assert ior._on_grid(datetime(2026, 7, 30, 14, 45, tzinfo=_IST))

    def test_snapshot_bar_rejected(self):
        assert not ior._on_grid(datetime(2026, 7, 30, 9, 30, 20, tzinfo=_IST))
        assert not ior._on_grid(datetime(2026, 7, 30, 9, 37, tzinfo=_IST))
