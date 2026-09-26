"""Regression test: intraday_ranker's news window must bind tz-aware INSTANTS.

`_news_sentiment` advertises that it mirrors technicalSignalsService.loadRecentNewsSentiment, but
the mirror drifted: the TS builds its bounds with `new Date(...).toISOString()` (a full instant),
while the Python bound `date.today().isoformat()` — a bare calendar date. Against a
`fetched_at TIMESTAMPTZ` column Postgres resolves a bare date in the SESSION timezone (UTC live),
so '2026-09-24' meant 2026-09-24T00:00Z. Three defects, none of them a crash, which is why they
survived:

  * `days=2` did not mean 48 hours — it meant "since midnight UTC, 2 days back", i.e. 48h to 72h
    of news depending purely on the time of day the ranker ran. Same code, same day, different
    feature value.
  * `date.today()` is the *host's* local calendar day while the comparison runs in the session
    timezone. This box is IST (UTC+05:30) under a UTC session, so the window slid up to 5.5h with
    the machine's clock setting.
  * the upper bound was anchored to TODAY+1 instead of the scan's as-of date — precisely what the
    TS comment guards against ("so a historical scan never sees news fetched after it"). Latent
    only because this method has no as-of parameter yet.

Measured live 2026-09-26 at days=2: old bound 19,010 articles / 2,041 symbols vs new bound
18,550 / 2,026 — so on the live box the old window was ~3.4% WIDER, not narrower. The bug class is
the non-determinism and the host dependence, not a headline loss of articles; do not describe it
as one. See src/server/tests/_negctl_intraday_tz.py, which proves these assertions fire against
the old expressions.

A bare-date bound is the class this repo has already been bitten by twice (see
test_factor_edge_tz_dates.py and the queues.ts cron-tz comment). This is what stops the third.
"""
import os
import sys
import types
from datetime import datetime, timedelta, timezone

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import intraday_ranker as ir


class _CaptureConn:
    """Records the bound parameters of the single query _news_sentiment issues."""

    def __init__(self):
        self.params = None

    def execute(self, sql, params=()):
        self.params = params
        return types.SimpleNamespace(fetchall=lambda: [])


def _bounds(days: int = 2):
    r = ir.IntradayRanker.__new__(ir.IntradayRanker)   # skip __init__/DB connect
    conn = _CaptureConn()
    r.conn = conn
    r._news_sentiment(days=days)
    cutoff, upper = conn.params
    return datetime.fromisoformat(cutoff), datetime.fromisoformat(upper)


def test_window_bounds_are_tz_aware_instants():
    """The bug was binding 'YYYY-MM-DD'. A bare date has no zone, so Postgres reads it in the
    session timezone and the window silently shifts by the zone offset."""
    cutoff, upper = _bounds()
    for label, dt in (("cutoff", cutoff), ("upper", upper)):
        assert dt.tzinfo is not None and dt.utcoffset() is not None, (
            f"{label} bound {dt!r} is timezone-NAIVE — Postgres will resolve it in the session "
            "timezone and silently shift the news window"
        )


def test_cutoff_does_not_snap_to_midnight():
    """Midnight-snapping is what dropped the 00:00–05:30 IST overnight-news window."""
    cutoff, _ = _bounds(days=2)
    assert not (cutoff.hour == 0 and cutoff.minute == 0 and cutoff.second == 0), (
        "cutoff snapped to midnight — the overnight news window is being cut off again"
    )


def test_cutoff_tracks_wall_clock_not_the_calendar_date():
    now = datetime.now(timezone.utc)
    cutoff, _ = _bounds(days=1)
    # Asserted explicitly so a naive bound fails HERE with a readable message instead of
    # blowing up in the subtraction below with a TypeError that hides what broke.
    assert cutoff.tzinfo is not None, "naive cutoff — anchored to a calendar day, not an instant"
    drift = abs((now - cutoff) - timedelta(days=1)).total_seconds()
    assert drift < 300, f"cutoff is {drift:.0f}s away from now-1d; must track the actual instant"
