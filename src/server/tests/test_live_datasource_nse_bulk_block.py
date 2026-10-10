"""Live-datasource test for nse_bulk_block_fetcher (data-sources.md mandate).

Calls the fetcher's OWN run() (its NseClient session, URL builder, CSV parser and upsert) against the
real nsearchives files, writes into a throwaway schema (pg_conn) and reads the rows back. The symbol
master is seeded from scripts/stocklist.json, never hardcoded. Skipped unless RUN_LIVE_DATASOURCE_TESTS=1.
"""
import json
import os
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nse_bulk_block_fetcher as bb  # noqa: E402
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite  # noqa: E402
from nse_filings_common import NseClient, today_ist  # noqa: E402

STOCKLIST = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "stocklist.json")


@pytest.mark.live_datasource
def test_daily_bulk_and_block_files_write_typed_rows(pg_conn):
    with open(STOCKLIST, encoding="utf-8-sig") as f:
        symbols = [(e["symbol"],) for e in json.load(f) if e.get("symbol")]
    pg_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY)")
    pg_conn.execute("CREATE TABLE nse_universe_history (date DATE, symbol TEXT)")
    pg_conn.executemany("INSERT INTO nse_stocks VALUES (?) ON CONFLICT DO NOTHING", symbols)
    pg_conn.commit()
    bb.ensure_schema(pg_conn)

    client = NseClient(max_requests=4)
    stats = bb.run(pg_conn, client, bb.load_known_symbols(pg_conn))
    assert stats["stop"] is None, stats
    # bulk.csv carried 155 rows on 09-Oct-2026; an empty bulk file on a trading day is a failure.
    assert stats["bulk"]["raw"] > 0 and stats["bulk"]["written"] > 0, stats
    rows = pg_conn.execute(
        f"SELECT symbol, trade_date, buy_sell, quantity, price, value_cr FROM {bb.TABLE}").fetchall()
    for sym, d, side, qty, price, val in rows:
        assert_looks_like_ticker(sym, context=f"{bb.TABLE}.symbol")
        d = date.fromisoformat(str(d)[:10])  # db_compat hands DATE back as text
        assert today_ist() - timedelta(days=7) <= d <= today_ist(), d  # the last trading day's file
        assert side in ("BUY", "SELL"), side
        for v, col in ((qty, "quantity"), (price, "price"), (val, "value_cr")):
            assert_numeric_and_finite(v, context=f"{bb.TABLE}.{col}")
