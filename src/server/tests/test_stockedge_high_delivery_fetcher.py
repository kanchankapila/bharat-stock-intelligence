"""Regression tests for stockedge_high_delivery_fetcher.py.

Fixture shaped from a real payload captured live 2026-08-14 (LGEINDIA).
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import stockedge_high_delivery_fetcher as sef

UNIVERSE = {"LGEINDIA", "ASTRAL", "URBANCO"}

REAL_ROW = {
    "ID": 103143, "Date": "2026-08-14T00:00:00", "AlertType": 1002, "ListingID": 103143,
    "SecurityID": 112656, "Exch": "NSE", "Symb": "LGEINDIA", "Name": "LG Electronics India Ltd.",
    "SortValue": 19.42,
    "Info": {"DQ1": 3684320.0, "TimesDQ": 19.41680852073002, "Avg5DQ": 189749.0,
              "C1": 1729.7, "C1ZG": 9.59},
    "Slug": "lg-electronics-india",
}


class TestParseAlert:
    def test_maps_a_real_row(self):
        r = sef.parse_alert(REAL_ROW, UNIVERSE)
        assert r["id"] == "stockedge:103143"
        assert r["symbol"] == "LGEINDIA"
        assert r["alert_date"] == "2026-08-14"
        assert r["times_delivery_qty"] == 19.41680852073002
        assert r["delivery_qty"] == 3684320.0
        assert r["source"] == "stockedge"
        assert set(r.keys()) == set(sef.COLS)

    def test_symbol_not_in_universe_is_dropped(self):
        assert sef.parse_alert({**REAL_ROW, "Symb": "NOTAREALSYMBOL"}, UNIVERSE) is None

    def test_missing_id_is_dropped(self):
        assert sef.parse_alert({**REAL_ROW, "ID": None}, UNIVERSE) is None

    def test_missing_date_is_dropped(self):
        assert sef.parse_alert({**REAL_ROW, "Date": ""}, UNIVERSE) is None

    def test_nan_numeric_becomes_none(self):
        row = {**REAL_ROW, "Info": {**REAL_ROW["Info"], "TimesDQ": float("nan")}}
        r = sef.parse_alert(row, UNIVERSE)
        assert r["times_delivery_qty"] is None

    def test_non_dict_info_treated_as_empty(self):
        """Some providers on this platform return [] instead of {} for an empty nested object
        (recurring-bugs.md's trading80_header_info precedent) -- guard the same way here."""
        row = {**REAL_ROW, "Info": []}
        r = sef.parse_alert(row, UNIVERSE)
        assert r["times_delivery_qty"] is None
        assert r["delivery_qty"] is None


class TestSchemaAndStorage:
    def test_ensure_schema_and_upsert_round_trip(self):
        con = sqlite3.connect(":memory:")
        sef.ensure_schema(con)
        row = sef.parse_alert(REAL_ROW, UNIVERSE)
        assert sef.store(con, [row]) == 1
        result = con.execute(
            "SELECT symbol, alert_date, times_delivery_qty FROM stockedge_high_delivery_alerts"
        ).fetchone()
        assert result == ("LGEINDIA", "2026-08-14", 19.41680852073002)

    def test_upsert_is_idempotent(self):
        con = sqlite3.connect(":memory:")
        sef.ensure_schema(con)
        row = sef.parse_alert(REAL_ROW, UNIVERSE)
        assert sef.store(con, [row]) == 1
        assert sef.store(con, [row]) == 1
        count = con.execute("SELECT COUNT(*) FROM stockedge_high_delivery_alerts").fetchone()[0]
        assert count == 1

    def test_store_empty_list_is_a_noop(self):
        con = sqlite3.connect(":memory:")
        sef.ensure_schema(con)
        assert sef.store(con, []) == 0
