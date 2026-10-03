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
from datetime import date, datetime, timedelta, timezone

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


class TestPaperTradeShort:
    """direction='SHORT' -- target below entry, stop above; profit when price FALLS. Added
    2026-08 alongside the Sell-side emission gate (intraday_recommendation_outcomes.direction).
    """

    def test_price_falling_to_target_is_a_win(self):
        bars = _bars((100.0, 101.0, 99.0, 100.0), (100.0, 100.0, 93.0, 94.0))
        exit_p, reason, pnl, outcome = ior.paper_trade(100.0, 95.0, 105.0, bars, "SHORT")
        assert reason == "TARGET"
        assert exit_p == pytest.approx(95.0)
        assert outcome == "WIN" and pnl > 0

    def test_price_rising_to_stop_is_a_loss(self):
        bars = _bars((100.0, 101.0, 99.0, 100.0), (100.0, 106.0, 100.0, 105.0))
        exit_p, reason, pnl, outcome = ior.paper_trade(100.0, 95.0, 105.0, bars, "SHORT")
        assert reason == "STOP"
        assert exit_p == pytest.approx(105.0)
        assert outcome == "LOSS" and pnl < 0

    def test_entry_bar_cannot_trigger_its_own_stop(self):
        bars = _bars((100.0, 150.0, 100.0, 100.0), (100.0, 100.0, 100.0, 100.0))
        _exit, reason, _pnl, _out = ior.paper_trade(100.0, 95.0, 105.0, bars, "SHORT")
        assert reason == "CLOSE"

    def test_stop_wins_ties_within_one_bar(self):
        """Same conservative tie-break as the long side: an ambiguous bar assumes the worst."""
        bars = _bars((100.0, 100.0, 100.0, 100.0), (100.0, 110.0, 90.0, 100.0))
        _exit, reason, _pnl, _out = ior.paper_trade(100.0, 95.0, 105.0, bars, "SHORT")
        assert reason == "STOP"

    def test_flat_round_trip_loses_exactly_the_modelled_cost(self):
        bars = _bars((100.0, 100.0, 100.0, 100.0), (100.0, 100.0, 100.0, 100.0))
        _e, _r, pnl, outcome = ior.paper_trade(100.0, 95.0, 105.0, bars, "SHORT")
        expected = -(ior.INTRADAY_SLIPPAGE_BPS / 100.0) - (2 * ior.INTRADAY_COMMISSION_BPS / 100.0)
        assert pnl == pytest.approx(expected, abs=0.01)
        assert outcome == "LOSS"

    def test_long_and_short_are_never_conflated_by_default_argument(self):
        """Negative control: omitting direction must resolve to LONG (existing call sites don't
        pass it), never silently to SHORT."""
        long_bars = _bars((100.0, 101.0, 99.0, 100.0), (100.0, 106.0, 100.0, 105.5))
        no_direction = ior.paper_trade(100.0, 105.0, 95.0, long_bars)
        explicit_long = ior.paper_trade(100.0, 105.0, 95.0, long_bars, "LONG")
        assert no_direction == explicit_long
        assert no_direction[1] == "TARGET"  # would be "STOP"-prone under SHORT's inverted test


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


class _FixedDatetime(datetime):
    """datetime subclass pinned to one instant, for the pre/post-close branch."""

    _pinned: datetime

    def __new__(cls, pinned: datetime):
        obj = super().__new__(cls, pinned.year, pinned.month, pinned.day,
                             pinned.hour, pinned.minute, pinned.second,
                             pinned.microsecond, pinned.tzinfo)
        obj._pinned = pinned
        return obj

    def now(self, tz=None):
        return self._pinned if tz is None else self._pinned.astimezone(tz)

    def today(self):
        return self._pinned.date()

    @staticmethod
    def now_utc(*_a, **_k):
        raise AssertionError("unused")


class _FakeConn:
    """Minimal conn standing in for the two tables ungraded_sessions() reads. Row shape follows
    the real columns; `grouped` is the (computed_at, gradeable_cycle_count) the query returns."""

    def __init__(self, grouped):
        self._grouped = grouped

    def execute(self, sql, params=()):
        return self


    def fetchall(self):
        return [(g, 1) for g in self._grouped]


class TestUngradedSessionDetection:
    """AF-20261001-05: on 2026-09-30 `ml-daily-ops` was orphaned twice by pm2 restarts (the run
    9 min in, then its make-up 44 min in), leaving 3,152 actionable signals with no outcome rows
    -- and the next night's run only ever grades *today*, so the session was ungradeable forever
    and silently vanished from the win rate the emission gate and strategy learner read."""

    def test_session_with_outcomes_is_not_backfilled(self):
        assert ior.ungraded_sessions(_FakeConn([])) == []

    def test_lost_session_is_detected(self):
        assert ior.ungraded_sessions(_FakeConn(["2026-09-30"])) == ["2026-09-30"]

    def test_multiple_lost_sessions_are_returned_in_order(self):
        conn = _FakeConn(["2026-09-28", "2026-09-29", "2026-09-30"])
        assert ior.ungraded_sessions(conn) == ["2026-09-28", "2026-09-29", "2026-09-30"]

    def test_query_requires_a_complete_geometry_and_an_actionable_classification(self):
        """A session whose cycles carry no entry/target/stop, or are all Hold, has nothing a
        paper trade could resolve -- backfilling it would manufacture 'no tradeable recs' noise
        every night. The SQL, not the caller, is the guard."""
        import inspect
        sql = inspect.getsource(ior.ungraded_sessions)
        for needle in ("entry_price IS NOT NULL", "target_1 IS NOT NULL",
                       "stop_loss IS NOT NULL", "NOT EXISTS"):
            assert needle in sql, f"ungraded_sessions lost its {needle!r} guard"

    def test_backfill_grades_each_detected_session(self, monkeypatch):
        seen = []
        monkeypatch.setattr(ior, "ungraded_sessions", lambda conn, days=7: ["2026-09-29", "2026-09-30"])
        monkeypatch.setattr(ior, "resolve",
                            lambda conn, d: (seen.append(d), {"resolved": 5})[1])
        monkeypatch.setattr(ior, "_gradable_cycles", lambda conn, d: 99)
        out = ior.backfill_ungraded(_FakeConn([]))
        assert seen == ["2026-09-29", "2026-09-30"]
        assert [o["date"] for o in out] == ["2026-09-29", "2026-09-30"]
        assert all(o["resolved"] == 5 and o["gradeable_cycles"] == 99 for o in out)

    def test_open_session_is_excluded_before_the_close(self, monkeypatch):
        """The intraday chain writes shadow cycles all day, so `computed_at = today` always looks
        gradeable. Grading it at 11:30 IST would square every signal off at whatever bar exists
        so far -- exits that never happened. Negative control: the same rows ARE included once
        15:30 IST has passed, which is when the nightly job actually runs."""
        today = date.today().isoformat()

        class _SpyConn:
            """Honours both bounds the function binds, so the assertions test the real filter."""

            def __init__(self):
                self.params = []

            def execute(self, sql, params=()):
                self.params.append(tuple(params))
                return self

            def fetchall(self):
                lo, hi = self.params[-1]
                return [(today, 1)] if lo <= today <= hi else []

        # 11:00 IST -- mid-session
        monkeypatch.setattr(ior, "datetime", _FixedDatetime(datetime(2026, 10, 1, 5, 30, tzinfo=timezone.utc)))
        conn = _SpyConn()
        assert ior.ungraded_sessions(conn) == []
        assert conn.params[0] == ((date.today() - timedelta(days=7)).isoformat(),
                                  (date.today() - timedelta(days=1)).isoformat()), \
            "before the close the upper bound must EXCLUDE today -- narrowing the lower bound " \
            "would still admit it, which is the row this guard exists to protect"

        # 16:30 IST -- after the close, same rows now included
        monkeypatch.setattr(ior, "datetime", _FixedDatetime(datetime(2026, 10, 1, 11, 0, tzinfo=timezone.utc)))
        conn2 = _SpyConn()
        assert ior.ungraded_sessions(conn2) == [today]
        assert conn2.params[0] == ((date.today() - timedelta(days=7)).isoformat(), today)

    def test_lookback_is_used_verbatim_after_the_close(self):
        assert ior.NSE_CLOSE_MINUTES_IST == 930
