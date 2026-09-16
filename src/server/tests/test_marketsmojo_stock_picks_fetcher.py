"""Regression tests for marketsmojo_stock_picks_fetcher.py.

Fixture shaped from a real payload captured live 2026-08-15 (GE Vernova T&D).
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pg_test_support import pg_memory_conn  # noqa: E402

import marketsmojo_stock_picks_fetcher as msp

SID_MAP = {"628721": "GEVERNOVA"}

REAL_ROW = {
    "stockname": "GE Vernova T&D", "stockid": 628721, "added_date": "04 Feb 25",
    "exit_date": "Currently Live", "entry_price": "1647.70", "exit_price": "",
    "added_price": "1647.70", "change_perc": 164.1, "change_dir": 1,
    "bse500return": "8.09%", "bse500return_clr": "green", "currentprice": "4351.60",
}

REAL_EXITED_ROW = {
    "stockname": "Some Exited Co", "stockid": 628721, "added_date": "10 Jan 25",
    "exit_date": "15 Mar 25", "entry_price": "100.00", "exit_price": "150.00",
    "added_price": "100.00", "change_perc": 50.0, "change_dir": 1,
    "bse500return": "5.00%", "currentprice": "150.00",
}


class TestParsePick:
    def test_maps_a_real_open_row(self):
        r = msp.parse_pick("activestocks", REAL_ROW, SID_MAP)
        assert r["id"] == "marketsmojo:activestocks:628721:04 Feb 25"
        assert r["symbol"] == "GEVERNOVA"
        assert r["is_open"] == 1
        assert r["entry_price"] == 1647.70
        assert r["change_pct"] == 164.1
        assert r["bse500_return_pct"] == 8.09
        assert r["source"] == "marketsmojo"
        assert set(r.keys()) == set(msp.COLS)

    def test_maps_a_real_exited_row(self):
        r = msp.parse_pick("allstocks", REAL_EXITED_ROW, SID_MAP)
        assert r["is_open"] == 0
        assert r["exit_price"] == 150.00
        assert r["exit_date_label"] == "15 Mar 25"

    def test_unresolved_stockid_is_dropped(self):
        assert msp.parse_pick("activestocks", {**REAL_ROW, "stockid": 424242}, SID_MAP) is None

    def test_missing_added_date_is_dropped(self):
        assert msp.parse_pick("activestocks", {**REAL_ROW, "added_date": ""}, SID_MAP) is None

    def test_blank_numeric_string_becomes_none(self):
        r = msp.parse_pick("activestocks", REAL_ROW, SID_MAP)
        assert r["exit_price"] is None  # exit_price was "" on the real open row


class TestSchemaAndStorage:
    def test_ensure_schema_and_upsert_round_trip(self):
        con = pg_memory_conn()
        msp.ensure_schema(con)
        row = msp.parse_pick("activestocks", REAL_ROW, SID_MAP)
        assert msp.store(con, [row]) == 1
        result = con.execute(
            "SELECT symbol, is_open, entry_price FROM marketsmojo_stock_picks"
        ).fetchone()
        assert result == ("GEVERNOVA", 1, 1647.70)

    def test_upsert_is_idempotent(self):
        con = pg_memory_conn()
        msp.ensure_schema(con)
        row = msp.parse_pick("activestocks", REAL_ROW, SID_MAP)
        assert msp.store(con, [row]) == 1
        assert msp.store(con, [row]) == 1
        count = con.execute("SELECT COUNT(*) FROM marketsmojo_stock_picks").fetchone()[0]
        assert count == 1

    def test_store_empty_list_is_a_noop(self):
        con = pg_memory_conn()
        msp.ensure_schema(con)
        assert msp.store(con, []) == 0
