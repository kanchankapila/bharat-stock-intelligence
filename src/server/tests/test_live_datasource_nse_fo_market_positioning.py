"""Live-datasource test for nse_fo_market_positioning_fetcher (data-sources.md mandate, AF-20261119-19).

Calls the fetcher's OWN run() (its NseClient session, URL builder, parsers and writers) against the real
nsearchives files, writes into a throwaway schema (pg_conn) and reads the rows back. Sessions are seeded as
the last ten weekdays (holidays 404 and are reported, not failed); the symbol master comes from
scripts/stocklist.json, never hardcoded. Skipped unless RUN_LIVE_DATASOURCE_TESTS=1.
"""
import json
import os
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nse_fo_market_positioning_fetcher as fp  # noqa: E402
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite  # noqa: E402
from nse_filings_common import NseClient, today_ist  # noqa: E402

STOCKLIST = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "stocklist.json")


@pytest.mark.live_datasource
def test_participant_files_and_ban_list_write_typed_rows(pg_conn):
    with open(STOCKLIST, encoding="utf-8-sig") as f:
        symbols = [(e["symbol"],) for e in json.load(f) if e.get("symbol")]
    until = today_ist() - timedelta(days=1)
    days = [until - timedelta(days=i) for i in range(14) if (until - timedelta(days=i)).weekday() < 5][:10]
    pg_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY)")
    pg_conn.execute("CREATE TABLE nse_universe_history (date DATE, symbol TEXT)")
    pg_conn.executemany("INSERT INTO nse_stocks VALUES (?) ON CONFLICT DO NOTHING", symbols)
    pg_conn.executemany("INSERT INTO nse_universe_history VALUES (?, 'RELIANCE')", [(d.isoformat(),) for d in days])
    pg_conn.commit()
    fp.ensure_schema(pg_conn)

    stats = fp.run(pg_conn, NseClient(max_requests=30), min(days), until, fp.load_known_symbols(pg_conn))
    assert stats["stop"] is None, stats
    assert stats["participant_written"] >= 5 * 2 * 5, stats  # >= 5 published sessions x 2 kinds x 5 rows

    rows = pg_conn.execute(
        f"SELECT trade_date, kind, client_type, fut_idx_long, total_long, total_short FROM {fp.PARTICIPANT_TABLE}"
    ).fetchall()
    for d, kind, ct, fil, tl, ts in rows:
        assert date.fromisoformat(str(d)[:10]) in days and kind in fp.KINDS and ct in fp.PARTICIPANTS
        for v, col in ((fil, "fut_idx_long"), (tl, "total_long"), (ts, "total_short")):
            assert_numeric_and_finite(v, context=f"{fp.PARTICIPANT_TABLE}.{col}")

    ban = stats["ban"]
    assert ban is not None, stats
    assert today_ist() <= date.fromisoformat(ban["trade_date"]) <= today_ist() + timedelta(days=6), ban
    for sym in ban["symbols"] + ban["unknown"]:
        assert_looks_like_ticker(sym, context="fo_secban.csv symbol")
    stored = pg_conn.execute(f"SELECT symbol FROM {fp.BAN_TABLE} WHERE trade_date = ?", (ban["trade_date"],)).fetchall()
    assert sorted(r[0] for r in stored) == ban["symbols"]
