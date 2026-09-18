"""Live-datasource test for mc_block_deal_history_fetcher (AF-20260914-02).

Mandated by `data-sources.md`: hits the REAL endpoint for one real ticker, parses with the
fetcher's OWN functions (never a reimplementation, or the test can pass while the code is
broken), asserts the response is shaped as expected, then writes through the fetcher's own
DB-write function into a throwaway schema and reads the row back to confirm it is ML-usable.

Skipped by default. Run with RUN_LIVE_DATASOURCE_TESTS=1.

RELIANCE is the deliberate choice: this whole source exists because NSE's historical ranges are
503 and the tickertape crawl is small/mid-cap heavy, leaving RELIANCE/TCS/INFY/HDFCBANK with ZERO
block-deal rows. If the large caps ever stop resolving here, the reason for the fetcher is gone
and this test should be the thing that says so.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mc_block_deal_history_fetcher as mcbd  # noqa: E402
from live_datasource_helpers import (  # noqa: E402
    assert_looks_like_ticker,
    assert_numeric_and_finite,
)

pytestmark = pytest.mark.live_datasource

SYMBOL = "RELIANCE"


@pytest.fixture(scope="module")
def live_rows():
    import requests
    session = requests.Session()
    # Resolve the provider id the way the fetcher does -- forward, from the repo's own mapping --
    # rather than hardcoding a code that could go stale silently.
    from db_compat import connect
    conn = connect()
    try:
        universe = mcbd.load_universe(conn, SYMBOL, 1)
    finally:
        conn.close()
    assert universe, f"{SYMBOL} has no mcsymbol in nse_stocks -- resolution, not the vendor, is broken"
    symbol, mcsymbol = universe[0]
    raw, err = mcbd.fetch_symbol_pages(session, mcsymbol)
    assert err is None, f"live fetch failed for {symbol} ({mcsymbol}): {err}"
    return symbol, raw


def test_live_endpoint_returns_a_non_empty_block_deal_history(live_rows):
    symbol, raw = live_rows
    assert raw, f"{symbol} returned zero block deals -- the large-cap gap this fetcher exists to close"
    first = raw[0]
    for key in ("datetime", "type", "quantity", "price"):
        assert key in first, f"vendor payload lost the {key!r} field: {sorted(first)}"


def test_pagination_walks_past_the_first_page(live_rows):
    """`seemore` is the contract; a single-page read would silently truncate the history."""
    _, raw = live_rows
    # Page 1 carries 8 rows for this vendor; more than that proves the walk continued.
    assert len(raw) > 8, (
        f"only {len(raw)} rows -- pagination stopped at page 1, so history is being truncated"
    )


def test_parsed_rows_are_ml_usable(live_rows):
    """The fetcher's OWN parser, then the shape assertions data-sources.md mandates."""
    symbol, raw = live_rows
    deals = mcbd.parse_rows(symbol, raw)
    assert deals, "every live row was dropped by parse_rows -- the vendor shape changed"

    d = deals[0]
    assert_looks_like_ticker(d["symbol"])
    assert_numeric_and_finite(d["qty"])
    assert_numeric_and_finite(d["price"])
    assert_numeric_and_finite(d["value_cr"])
    # The two documented traps, asserted on real vendor data rather than on a fixture.
    assert d["trade_type"] in ("BUY", "SELL"), f"unnormalised trade_type {d['trade_type']!r}"
    assert len(d["date"]) == 10 and d["date"][4] == "-", (
        f"date {d['date']!r} is not ISO -- a display-format date reached the row"
    )


def test_ids_are_stable_across_a_reparse(live_rows):
    """Content-hash ids: re-running must update in place, not duplicate."""
    symbol, raw = live_rows
    a = {d["id"] for d in mcbd.parse_rows(symbol, raw)}
    b = {d["id"] for d in mcbd.parse_rows(symbol, raw)}
    assert a == b and a, "deal ids are not stable across two parses of the same payload"


def test_write_and_read_back_through_the_fetchers_own_writer(live_rows, pg_db_conn):
    """Writes with store(), reads the row back, asserts it is usable -- not just that it inserted."""
    symbol, raw = live_rows
    deals = mcbd.parse_rows(symbol, raw)[:5]
    assert deals

    mcbd.store(pg_db_conn, deals)

    row = pg_db_conn.execute(
        "SELECT symbol, date, qty, price, value_cr, trade_type, source "
        "FROM block_deals WHERE id = ?", (deals[0]["id"],)).fetchone()
    assert row is not None, "store() reported success but the row is not readable back"

    got = dict(zip(("symbol", "date", "qty", "price", "value_cr", "trade_type", "source"), row))
    assert_looks_like_ticker(got["symbol"])
    assert_numeric_and_finite(got["qty"])
    assert_numeric_and_finite(got["price"])
    assert got["trade_type"] in ("BUY", "SELL")
    assert got["source"] == "moneycontrol"

    # Idempotence against the live payload, which is what the content hash buys.
    mcbd.store(pg_db_conn, deals)
    n = pg_db_conn.execute(
        "SELECT count(*) FROM block_deals WHERE id = ?", (deals[0]["id"],)).fetchone()[0]
    assert n == 1, f"re-storing the same deal produced {n} rows -- the id is not stable"
