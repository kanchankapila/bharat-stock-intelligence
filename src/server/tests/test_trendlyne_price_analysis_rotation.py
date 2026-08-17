"""
Pins _load_stocks()'s work ORDER in trendlyne_price_analysis_fetcher.py.

Why this exists, and why ordering (not just the resume filter) is the load-bearing part here:

This fetcher's siblings key their resume-skip on logical_write_floor() -- the last completed
OHLCV session -- so their `done` set survives midnight and their coverage accumulates across
calendar days until the whole universe is in. This one cannot: its `date` column is a real
calendar date (extract_features needs it for the seasonal-month lookup), so `done` empties every
midnight and each day restarts from scratch.

That is survivable on its own. It stopped being survivable once the catch-up rotation gave the
script a bounded per-run budget: ~18 slices/day (one per 80 min) x 110 rows = 1,980 < 2,234
mapped tlids. With the candidate list ordered by symbol, every run took the alphabetically-first
110 of what was left, so every day covered ranks 1..1,980 and re-cut the SAME tail -- universe
ranks ~1,981+ were never fetched on any day, deterministically, forever. Nothing reported it: the
coverage check of the day measured a percentage on MAX(date) and saw a number that only ever
looked "partial", never "permanently missing these exact names".

Live evidence, 2026-08-17: that day's coverage was a contiguous alphabetical prefix -- universe
ranks 1..692 with a single gap inside the span -- and a rolling 3-day window held 691 of 2,234
distinct symbols. After the fix the next run's 110-row slice was 110/110 never-before-fetched
symbols spanning ranks 326..801, i.e. the starved names, not the next slice of the alphabet.

Negative control (run 2026-08-17): deleting the `rows.sort(key=...)` line makes
test_never_fetched_symbols_are_served_before_recently_fetched_ones and
test_ordering_is_by_staleness_not_alphabet both fail (ZZZNEVER comes last instead of first);
test_already_fetched_symbols_are_skipped keeps passing either way, which is the point -- the
resume filter alone never protected against this.

Runs against real Postgres via pg_conn, mirroring test_trendlyne_adv_tech_resumability.py --
auto-skips if Postgres is unreachable.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from conftest import pg_available  # noqa: E402
from trendlyne_price_analysis_fetcher import _load_stocks, ensure_schema  # noqa: E402

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")

TODAY = "2026-08-17"

# Alphabetical order and staleness order are deliberately OPPOSITE here: AAAFRESH sorts first by
# symbol but was fetched most recently, ZZZNEVER sorts last but has never been fetched at all.
# A loader ordering by symbol serves AAAFRESH first; one ordering by staleness serves ZZZNEVER
# first. Nothing in between can pass both assertions by accident.
UNIVERSE = [("AAAFRESH", "900001"), ("MMMOLD", "900002"), ("ZZZNEVER", "900003")]


@pytest.fixture
def db(pg_conn):
    # pg_schema's search_path puts the throwaway schema FIRST, so a local nse_stocks here shadows
    # the real one for the rest of this connection -- _load_stocks()'s unqualified "FROM
    # nse_stocks" must never resolve to production. Minimal columns only, same as the sibling.
    cur = pg_conn.cursor()
    cur.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, tlid TEXT)")
    ensure_schema(pg_conn)
    for sym, tlid in UNIVERSE:
        cur.execute("INSERT INTO nse_stocks (symbol, tlid) VALUES (?, ?)", (sym, tlid))
    # Prior history on two of the three, on dates BEFORE today -- so neither is in today's
    # `done` set and both are still candidates, distinguished only by how stale they are.
    for sym, seen_on in [("AAAFRESH", "2026-08-16"), ("MMMOLD", "2026-07-01")]:
        cur.execute(
            "INSERT INTO trendlyne_price_analysis (symbol, date, fetched_at) "
            "VALUES (?, ?, CURRENT_TIMESTAMP)",
            (sym, seen_on),
        )
    pg_conn.commit()
    return pg_conn


def _symbols(rows):
    return [s for s, _ in rows]


def test_never_fetched_symbols_are_served_before_recently_fetched_ones(db):
    """The starved tail must be first in line, or a budget shorter than the universe never reaches it."""
    order = _symbols(_load_stocks(None, db, skip_done_for_date=TODAY))
    assert order[0] == "ZZZNEVER", (
        f"never-fetched symbol must be served first, got order {order}. A per-run budget below "
        f"the universe size cuts whatever is last, so ordering decides what is starved."
    )


def test_ordering_is_by_staleness_not_alphabet(db):
    """Full order is oldest-first; the alphabetical order would be the exact reverse."""
    order = _symbols(_load_stocks(None, db, skip_done_for_date=TODAY))
    assert order == ["ZZZNEVER", "MMMOLD", "AAAFRESH"], f"expected staleness order, got {order}"
    assert order != sorted(order), "ordering by symbol is what starved the alphabetical tail"


def test_already_fetched_symbols_are_skipped(db):
    """The resume filter still holds -- and on its own it would NOT have caught the starvation."""
    cur = db.cursor()
    cur.execute(
        "INSERT INTO trendlyne_price_analysis (symbol, date, fetched_at) "
        "VALUES (?, ?, CURRENT_TIMESTAMP)",
        ("ZZZNEVER", TODAY),
    )
    db.commit()
    order = _symbols(_load_stocks(None, db, skip_done_for_date=TODAY))
    assert "ZZZNEVER" not in order, "a symbol already fetched for the target date must not be refetched"
    assert order == ["MMMOLD", "AAAFRESH"], f"survivors must still be staleness-ordered, got {order}"


def test_explicit_symbol_run_is_unaffected(db):
    """An ad-hoc --symbol run bypasses the skip/order path entirely and must still resolve."""
    rows = _load_stocks("AAAFRESH", db, skip_done_for_date=None)
    assert _symbols(rows) == ["AAAFRESH"]
