"""Live-datasource test for institutional_deals_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

Pins the one endpoint quirk that would otherwise silently mislead: `dealValue` is a
WEEKLY-AGGREGATE total, not quantity*deal_price for the single deal shown on the row (module
docstring on institutional_deals_fetcher.py).
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import institutional_deals_fetcher as idf
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response, assert_numeric_and_finite


@pytest.mark.live_datasource
class TestInstitutionalDealsLiveDataSource:
    def test_real_fetch_both_sides_return_dated_rows(self):
        for action in idf.ACTIONS:
            rows = idf.fetch_deals(action, limit=10)
            assert_non_empty_response(rows, f"fetch_deals({action!r})")
            r = rows[0]
            assert r.get("symbol"), "expected a real symbol on every row"
            assert len(r.get("deal_date", "")) == 10, f"deal_date not ISO: {r.get('deal_date')!r}"
            assert r.get("ds_id") is not None

    def test_deal_value_is_not_derivable_from_quantity_times_price(self):
        """Confirms the module docstring's claim live -- if this ever starts matching, the
        upstream feed's aggregation semantics changed and the docstring/column naming
        (deal_value_cr_1w) needs revisiting, not just this assertion."""
        rows = idf.fetch_deals("buy", limit=10)
        assert rows
        mismatches = 0
        for r in rows:
            qty, price, value = r.get("quantity"), r.get("deal_price"), r.get("dealValue")
            if qty is None or price is None or value is None:
                continue
            naive_cr = (float(qty) * float(price)) / 1e7
            if abs(naive_cr - float(value)) > max(1.0, naive_cr * 0.05):
                mismatches += 1
        assert mismatches > 0, "expected at least one row where dealValue != quantity*price/1e7"

    def test_stored_rows_are_ml_usable(self):
        universe = idf.load_nse_universe()
        assert universe, "need a real nse_stocks universe to resolve symbols against"
        rows = []
        for action in idf.ACTIONS:
            raw = idf.fetch_deals(action, limit=20)
            rows.extend(r for r in (idf.parse_deal(action, d, universe) for d in raw) if r is not None)
        assert rows, "no usable (NSE-tickered) deal rows found across buy+sell sample"

        con = pg_memory_conn()
        idf.ensure_schema(con)
        assert idf.store(con, rows) == len(rows)

        symbol, action, deal_value = con.execute(
            "SELECT symbol, action, deal_value_cr_1w FROM institutional_deal_signals LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        assert action in ("buy", "sell")
        if deal_value is not None:
            assert_numeric_and_finite(deal_value, "deal_value_cr_1w")

    def test_buy_and_sell_ids_for_the_same_ds_id_never_collide(self):
        """boughtBy/action rows can share a ds_id across the buy/sell query (seen live for
        ADANIGREEN); the id must be namespaced by action or one side silently overwrites
        the other on upsert."""
        universe = idf.load_nse_universe()
        raw_buy = {"ds_id": 999, "symbol": next(iter(universe)), "deal_date": "2026-08-01",
                   "quantity": 100, "deal_price": 10, "dealValue": 1.0, "dealsCount": 1}
        raw_sell = dict(raw_buy)
        buy_row = idf.parse_deal("buy", raw_buy, universe)
        sell_row = idf.parse_deal("sell", raw_sell, universe)
        assert buy_row["id"] != sell_row["id"]
