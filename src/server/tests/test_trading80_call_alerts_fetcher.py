"""Regression tests for trading80_call_alerts_fetcher.py.

Fixture shaped from a real payload captured live 2026-08-15 (S H Kelkar & Co.).
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pg_test_support import pg_memory_conn  # noqa: E402

import trading80_call_alerts_fetcher as tca

SID_MAP = {"999929": "SHK", "176863": "GMMPFAUDLR"}

REAL_ROW = {
    "calltime": "10 Aug", "stockid": 999929, "sname": "S H Kelkar & Co.", "type": "BUY",
    "tcolor": "green", "calltype": "Monthly", "tprice": "184.58", "SL": "156.61",
    "reason": "BUY", "cmp": "171.10", "potential": "7.88", "pcolor": "green",
    "performance": 1.33, "perfColor": "green", "perfdays": "",
    "prob_success": "Call Probable Success Rate: 60%", "prob_success_color": "green",
    "call_extended": 0, "tag": "", "id": "6a75be8320aaef2e0280283e", "follow": 2,
    "call_duration": "W",
}


class TestParseCall:
    def test_maps_a_real_row(self):
        r = tca.parse_call("new", REAL_ROW, SID_MAP)
        assert r["id"] == "trading80:new:6a75be8320aaef2e0280283e"
        assert r["symbol"] == "SHK"
        assert r["target_price"] == 184.58
        assert r["stop_loss"] == 156.61
        assert r["cmp"] == 171.10
        assert r["performance_pct"] == 1.33
        assert r["source"] == "trading80"
        assert set(r.keys()) == set(tca.COLS)

    def test_unresolved_stockid_is_dropped(self):
        assert tca.parse_call("new", {**REAL_ROW, "stockid": 424242424242}, SID_MAP) is None

    def test_missing_id_falls_back_to_stockid_calltime_composite(self):
        """Live-confirmed: every 'changes'-list row carries a null id upstream. Falling back to
        stockid:calltime keeps the row instead of dropping the whole list."""
        r = tca.parse_call("changes", {**REAL_ROW, "id": None}, SID_MAP)
        assert r is not None
        assert r["id"] == "trading80:changes:999929:10 Aug"

    def test_missing_id_and_calltime_is_dropped(self):
        assert tca.parse_call("new", {**REAL_ROW, "id": "", "calltime": ""}, SID_MAP) is None

    def test_same_call_id_different_list_produces_different_row_id(self):
        """A call can appear in both new/ and changes/ across two fetches -- namespace by list
        so an update in changes never silently overwrites the new-list row or vice versa."""
        new_row = tca.parse_call("new", REAL_ROW, SID_MAP)
        changes_row = tca.parse_call("changes", REAL_ROW, SID_MAP)
        assert new_row["id"] != changes_row["id"]

    def test_numeric_string_with_thousands_comma_parses(self):
        row = {**REAL_ROW, "tprice": "1,234.50"}
        r = tca.parse_call("new", row, SID_MAP)
        assert r["target_price"] == 1234.50

    def test_blank_numeric_string_becomes_none(self):
        row = {**REAL_ROW, "SL": ""}
        r = tca.parse_call("new", row, SID_MAP)
        assert r["stop_loss"] is None


class TestSchemaAndStorage:
    def test_ensure_schema_and_upsert_round_trip(self):
        con = pg_memory_conn()
        tca.ensure_schema(con)
        row = tca.parse_call("new", REAL_ROW, SID_MAP)
        assert tca.store(con, [row]) == 1
        result = con.execute(
            "SELECT symbol, list_name, target_price FROM trading80_call_alerts"
        ).fetchone()
        assert result == ("SHK", "new", 184.58)

    def test_upsert_is_idempotent(self):
        con = pg_memory_conn()
        tca.ensure_schema(con)
        row = tca.parse_call("new", REAL_ROW, SID_MAP)
        assert tca.store(con, [row]) == 1
        assert tca.store(con, [row]) == 1
        count = con.execute("SELECT COUNT(*) FROM trading80_call_alerts").fetchone()[0]
        assert count == 1

    def test_store_empty_list_is_a_noop(self):
        con = pg_memory_conn()
        tca.ensure_schema(con)
        assert tca.store(con, []) == 0
