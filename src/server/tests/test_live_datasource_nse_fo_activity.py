"""Live-datasource test for nse_fo_activity_fetcher (data-sources.md mandate, AF-20261120-01).

Calls the fetcher's OWN run() (its NseClient session, URLs, parsers and writers) against the real NSE screens,
writes into a throwaway schema (pg_conn) and reads the rows back. Skipped unless RUN_LIVE_DATASOURCE_TESTS=1.
During the session the screens are live (not a close) and the fetcher refuses them, so the test skips then.
"""
import datetime as dt
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nse_fo_activity_fetcher as fa  # noqa: E402
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite  # noqa: E402
from nse_filings_common import NseClient, today_ist  # noqa: E402


@pytest.mark.live_datasource
def test_screens_write_one_closed_session_of_typed_rows(pg_conn):
    now = dt.datetime.now(fa.dt.timezone(dt.timedelta(hours=5, minutes=30)))
    if now.weekday() < 5 and dt.time(9, 0) <= now.time() < dt.time(15, 45):
        pytest.skip("market session in progress: NSE serves live screens, which the fetcher refuses by design")
    fa.ensure_schema(pg_conn)
    stats = fa.run(pg_conn, NseClient(max_requests=6))
    day = dt.date.fromisoformat(stats["trade_date"])
    assert today_ist() - dt.timedelta(days=6) <= day <= today_ist(), stats
    assert stats["contracts"] >= 100 and stats["underlyings"] >= 150, stats

    screens = {r[0] for r in pg_conn.execute(f"SELECT DISTINCT screen FROM {fa.CONTRACTS_TABLE}").fetchall()}
    assert screens == {"most_active_volume", "most_active_value"} | set(fa.SPURT_SCREENS.values())
    for sym, oi, chg in pg_conn.execute(
            f"SELECT symbol, open_interest, change_in_oi FROM {fa.CONTRACTS_TABLE} WHERE screen = 'long_buildup'").fetchall():
        assert_looks_like_ticker(sym, context=f"{fa.CONTRACTS_TABLE}.symbol")
        assert_numeric_and_finite(oi, context=f"{fa.CONTRACTS_TABLE}.open_interest")
        assert chg > 0, (sym, chg)
    for sym, latest in pg_conn.execute(f"SELECT symbol, latest_oi FROM {fa.UNDERLYINGS_TABLE}").fetchall():
        assert_looks_like_ticker(sym, context=f"{fa.UNDERLYINGS_TABLE}.symbol")
        assert_numeric_and_finite(latest, context=f"{fa.UNDERLYINGS_TABLE}.latest_oi")
