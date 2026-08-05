"""Live-datasource test for block_deal_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). Block deals are sparse by nature (a handful of large institutional
trades on any given day, sometimes zero) -- like insider_trades/bulk_deals, this test asserts
response *shape* rather than non-emptiness, and only validates stored rows when real deals
happen to exist on the day the test runs.
"""
import os

os.environ["USE_POSTGRES"] = "false"

import sqlite3
import sys
from datetime import date, timedelta

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import block_deal_fetcher as bdf
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite


def _make_test_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT)")
    conn.commit()
    bdf.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestBlockDealFetcherLiveDataSource:
    def test_live_endpoint_shape(self):
        """Hits the real NSE live block-deal endpoint. May legitimately be empty (block
        deals only happen in a dedicated pre-market session and not every day has any)."""
        session = requests.Session()
        session.headers.update(bdf.HEADERS)
        bdf._prime_session(session)
        raw_list = bdf.fetch_live(session)
        assert isinstance(raw_list, list), f"fetch_live() should return a list, got {type(raw_list)}"

        if raw_list:
            sample = raw_list[0]
            parsed = bdf._parse_deal(sample, date.today())
            assert parsed is not None, f"_parse_deal() rejected a real live deal row: {sample}"
            assert_looks_like_ticker(parsed["symbol"], context="block_deal.symbol")
            assert_numeric_and_finite(parsed["qty"], context="block_deal.qty")
            assert_numeric_and_finite(parsed["value_cr"], context="block_deal.value_cr")

    def test_upsert_and_backfill_write_ml_usable_rows_when_deals_exist(self):
        """Writes real live deals (if any exist today) through the fetcher's own
        upsert_deals()/backfill_technical_signals() into a throwaway DB. If no deals exist
        today, only asserts the write path doesn't error on an empty list -- a real-empty-day
        is expected, not a failure."""
        session = requests.Session()
        session.headers.update(bdf.HEADERS)
        bdf._prime_session(session)
        raw_list = bdf.fetch_live(session)

        conn = _make_test_conn()
        trade_date = date.today()
        saved = bdf.upsert_deals(raw_list, trade_date, conn)
        conn.execute("INSERT INTO technical_signals (symbol, date) SELECT symbol, ? FROM stock_block_deal_daily",
                     (trade_date.isoformat(),))
        conn.commit()
        updated = bdf.backfill_technical_signals(trade_date.isoformat(), conn)

        if raw_list:
            assert saved > 0, "upsert_deals() received real deals but saved zero rows"
            rows = conn.execute(
                "SELECT symbol, net_qty, total_value_cr FROM stock_block_deal_daily"
            ).fetchall()
            assert rows, "no rows landed in stock_block_deal_daily despite real deals being fetched"
            for symbol, net_qty, total_value_cr in rows:
                assert_looks_like_ticker(symbol, context="stock_block_deal_daily.symbol")
                assert_numeric_and_finite(net_qty, context="stock_block_deal_daily.net_qty")
                assert_numeric_and_finite(total_value_cr, context="stock_block_deal_daily.total_value_cr")
            assert updated > 0, "backfill_technical_signals() ran but updated zero rows despite real deal data existing"
        conn.close()
