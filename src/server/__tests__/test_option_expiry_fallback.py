"""NSE F&O expiry-day convention for the no-expiry-row fallback path.

Validated against live `nt_fno_expiry` on 2026-09-05: EVERY upcoming expiry is a TUESDAY
(2026-09-08/15/22/29, 2026-10-27), with 2026-11-23 a Monday where a holiday shifted it back.
There is no Thursday expiry in the table at all. Weekly expiries (09-08/15/22) carry exactly
ONE symbol -- the index -- while 09-29/10-27/11-23 carry 216, so equity F&O is monthly-only
and the fallback for a stock must resolve to the monthly, not a weekly.

`_nearest_thursday()` therefore returned a date on which NOTHING expires, for any symbol
missing an nt_fno_expiry row (4 of 210 F&O names as measured). It never produced a wrong
WRITE -- a dead expiry just yields an empty chain -- but it silently drops those symbols,
which is the same self-concealing shape as the coverage bug it sits next to.
"""
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from so_option_chain_fetcher import last_tuesday_expiry


def test_returns_this_months_last_tuesday_when_still_upcoming():
    # Live: on 2026-09-05 every equity F&O name's next expiry was 2026-09-29.
    assert last_tuesday_expiry(datetime.date(2026, 9, 5)) == "2026-09-29"


def test_expiry_day_itself_still_resolves_to_that_day():
    # The chain is live until the close on expiry day; rolling early would skip a session.
    assert last_tuesday_expiry(datetime.date(2026, 9, 29)) == "2026-09-29"


def test_rolls_to_next_month_once_this_months_expiry_has_passed():
    # Live: the month after 2026-09-29 is 2026-10-27, also a Tuesday.
    assert last_tuesday_expiry(datetime.date(2026, 9, 30)) == "2026-10-27"
    assert last_tuesday_expiry(datetime.date(2026, 10, 28)) == "2026-11-24"


def test_handles_a_month_ending_exactly_on_a_tuesday():
    # 2026-12-29 is a Tuesday and is in nt_fno_expiry; Dec 2026 ends Thursday the 31st.
    assert last_tuesday_expiry(datetime.date(2026, 12, 1)) == "2026-12-29"


def test_never_returns_a_thursday():
    """Negative control for the bug being replaced: the old fallback returned Thursdays."""
    d = datetime.date(2026, 1, 1)
    while d < datetime.date(2027, 1, 1):
        got = datetime.date.fromisoformat(last_tuesday_expiry(d))
        assert got.weekday() == 1, f"{d} -> {got} is not a Tuesday"
        assert got >= d, f"{d} -> {got} is in the past"
        d += datetime.timedelta(days=1)
