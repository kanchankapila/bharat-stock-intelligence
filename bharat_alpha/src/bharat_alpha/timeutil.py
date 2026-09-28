"""Time & trading calendar.

Rules (legacy's single largest bug cluster was dates — ~35 recorded instances):
  * All session logic is in Asia/Kolkata. `date.today()` is never used as a write anchor;
    the session date is always passed in or derived from `ist_now()`.
  * The PAST calendar is the exchange's own: a day traded iff its bhavcopy exists
    (`alpha.trading_day`). Lookbacks count TRADING days from that table, never calendar days.
  * The FUTURE calendar (for scheduling only) uses weekday + a configured holiday list. A
    missing holiday there costs one wasted job run that ends 'not_published', not bad data.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

IST = ZoneInfo("Asia/Kolkata")
MARKET_CLOSE = dt.time(15, 30)
# Bhavcopies are published in the evening; nothing dated d is usable before this.
EOD_KNOWABLE = dt.time(18, 30)

_HOLIDAY_FILE = Path(__file__).resolve().parents[2] / "config" / "nse_holidays.yaml"


def ist_now() -> dt.datetime:
    return dt.datetime.now(tz=IST)


def eod_knowable_at(d: dt.date) -> dt.datetime:
    return dt.datetime.combine(d, EOD_KNOWABLE, tzinfo=IST)


def _configured_holidays() -> set[dt.date]:
    if not _HOLIDAY_FILE.exists():
        return set()
    data = yaml.safe_load(_HOLIDAY_FILE.read_text()) or {}
    return {dt.date.fromisoformat(str(d)) for year in data.values() for d in (year or [])}


def is_probable_session(d: dt.date) -> bool:
    return d.weekday() < 5 and d not in _configured_holidays()


def next_probable_session(d: dt.date) -> dt.date:
    n = d + dt.timedelta(days=1)
    while not is_probable_session(n):
        n += dt.timedelta(days=1)
    return n


def latest_completed_session(now: dt.datetime | None = None) -> dt.date:
    """The most recent session whose EOD data should be published by `now`."""
    now = (now or ist_now()).astimezone(IST)
    d = now.date()
    if not (is_probable_session(d) and now.time() >= EOD_KNOWABLE):
        d -= dt.timedelta(days=1)
        while not is_probable_session(d):
            d -= dt.timedelta(days=1)
    return d
