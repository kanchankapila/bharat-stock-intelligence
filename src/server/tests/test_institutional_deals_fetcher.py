"""Regression tests for institutional_deals_fetcher.py.

Fixture shaped from a real payload captured live on 2026-08-06 (ADANIGREEN block deal, both
buy and sell sides sharing the same ds_id).
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

import institutional_deals_fetcher as idf

UNIVERSE = {"ADANIGREEN", "PAYTM", "MEESHO"}

REAL_BUY_ROW = {
    "ds_id": 159549226, "sc_id": "ADANI54145", "stockName": "Adani Green Energy Limited",
    "symbol": "ADANIGREEN", "exchange": "NSE", "sector": "Miscellaneous", "action": "Buy",
    "deal_type": "block", "deal_date": "2026-08-03",
    "boughtBy": "adani infra (india) limited", "quantity": 17000000, "deal_price": 1400,
    "dealValue": 10014.08, "dealsCount": 4,
}
REAL_SELL_ROW = {
    "ds_id": 159549225, "sc_id": "ADANI54145", "stockName": "Adani Green Energy Limited",
    "symbol": "ADANIGREEN", "exchange": "NSE", "sector": "Miscellaneous", "action": "Sell",
    "deal_type": "block", "deal_date": "2026-08-03",
    "boughtBy": "ardour investment holding ltd", "quantity": 17000000, "deal_price": 1400,
    "dealValue": 10014.08, "dealsCount": 4,
}


class TestParseDeal:
    def test_maps_a_real_buy_row(self):
        r = idf.parse_deal("buy", REAL_BUY_ROW, UNIVERSE)
        assert r["symbol"] == "ADANIGREEN"
        assert r["action"] == "buy"
        assert r["counterparty"] == "adani infra (india) limited"
        assert r["deal_value_cr_1w"] == pytest.approx(10014.08)
        assert r["deals_count_1w"] == 4
        assert r["source"] == "moneycontrol"

    def test_boughtby_maps_to_counterparty_on_sell_rows_too(self):
        """boughtBy is populated even on a Sell row (module docstring) -- it means
        'counterparty', not literally 'the buyer'. Renamed on storage for honesty."""
        r = idf.parse_deal("sell", REAL_SELL_ROW, UNIVERSE)
        assert r["counterparty"] == "ardour investment holding ltd"
        assert r["action"] == "sell"

    def test_deal_value_column_is_named_as_a_weekly_aggregate_not_a_single_deal_value(self):
        """The stored column is deal_value_cr_1w, not deal_value_cr -- the name itself must
        flag that this is a range-window aggregate (module docstring), not the value of the
        one deal whose quantity/price happen to be shown on the same row."""
        r = idf.parse_deal("buy", REAL_BUY_ROW, UNIVERSE)
        assert set(r.keys()) == set(idf.COLS)
        assert "deal_value_cr_1w" in r
        assert r["deal_value_cr_1w"] == pytest.approx(10014.08)

    def test_same_ds_id_different_action_produces_different_ids(self):
        """Confirmed live: MC can reuse a near-identical ds_id across the buy/sell query for
        the same underlying block trade. Namespacing by action prevents a silent overwrite."""
        buy = idf.parse_deal("buy", REAL_BUY_ROW, UNIVERSE)
        sell = idf.parse_deal("sell", {**REAL_BUY_ROW, "action": "Sell"}, UNIVERSE)
        assert buy["id"] != sell["id"]
        assert buy["id"] == "mc:buy:159549226"
        assert sell["id"] == "mc:sell:159549226"

    @pytest.mark.parametrize("bad", [
        {**REAL_BUY_ROW, "symbol": ""},
        {**REAL_BUY_ROW, "symbol": "NOTINUNIVERSE"},
        {**REAL_BUY_ROW, "deal_date": ""},
        {**REAL_BUY_ROW, "ds_id": None},
    ])
    def test_unusable_rows_are_dropped(self, bad):
        assert idf.parse_deal("buy", bad, UNIVERSE) is None

    def test_nan_numeric_becomes_none(self):
        row = {**REAL_BUY_ROW, "quantity": float("nan")}
        r = idf.parse_deal("buy", row, UNIVERSE)
        assert r["quantity"] is None


class TestSchemaAndStorage:
    def test_ensure_schema_and_upsert_round_trip(self):
        con = pg_memory_conn()
        idf.ensure_schema(con)
        buy = idf.parse_deal("buy", REAL_BUY_ROW, UNIVERSE)
        sell = idf.parse_deal("sell", REAL_SELL_ROW, UNIVERSE)
        assert idf.store(con, [buy, sell]) == 2
        rows = con.execute(
            "SELECT symbol, action, counterparty FROM institutional_deal_signals ORDER BY action"
        ).fetchall()
        assert rows == [("ADANIGREEN", "buy", "adani infra (india) limited"),
                         ("ADANIGREEN", "sell", "ardour investment holding ltd")]

    def test_upsert_is_idempotent(self):
        con = pg_memory_conn()
        idf.ensure_schema(con)
        buy = idf.parse_deal("buy", REAL_BUY_ROW, UNIVERSE)
        assert idf.store(con, [buy]) == 1
        assert idf.store(con, [buy]) == 1
        count = con.execute("SELECT COUNT(*) FROM institutional_deal_signals").fetchone()[0]
        assert count == 1

    def test_store_empty_list_is_a_noop(self):
        con = pg_memory_conn()
        idf.ensure_schema(con)
        assert idf.store(con, []) == 0
