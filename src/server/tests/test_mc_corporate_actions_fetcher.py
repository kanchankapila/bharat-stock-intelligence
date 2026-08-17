"""Regression tests for mc_corporate_actions_fetcher.py.

Fixtures shaped from real payloads captured live on 2026-08-07 (RELIANCE scId=RI for
dividends/bonus/rights, NESTLEIND scId=NI for splits -- RELIANCE has never split).
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

import mc_corporate_actions_fetcher as mca


RELIANCE_DATA = {
    "dividends": [
        {"announce_date": "2026-04-24", "dividend_type": "Final", "dividend_per": 60,
         "effective_date": "05 Jun, 2026", "remarks": "Rs.6.0000 per share(60%)Final Dividend",
         "dividend_amount": "6.00"},
        {"announce_date": "2025-04-25", "dividend_type": "Final", "dividend_per": 55,
         "effective_date": "10 Jun, 2025", "remarks": "", "dividend_amount": "5.50"},
    ],
    "bonus": [
        {"announcement_date": "05 Sep, 2024", "existing_ratio": 1, "offered_ratio": 1,
         "record_date": "2024-10-28", "exbonus_date": "28 Oct, 2024", "chkdeb": "",
         "bonus_ratio": "1:1"},
    ],
    "rights": [
        {"announce_date": "2020-04-30", "existing_ratio": 15, "offered_ratio": 1,
         "facevalue": 10, "premium": 1247, "record_date": "2020-05-14",
         "exrights_date": "13 May, 2020", "rights_ratio": "1:15"},
    ],
    # RELIANCE has never split -- "splits" key absent entirely, matching the real endpoint's
    # observed behaviour of omitting empty categories rather than returning an empty list.
}

NESTLEIND_SPLIT = {
    "splits": [
        {"announce_date": "2023-10-19", "old_fv": 10, "new_fv": 1,
         "exsplit_date": "05 Jan, 2024", "record_date": "2024-01-05"},
    ],
}


class TestParseDividends:
    def test_extracts_amount_and_effective_date(self):
        rows = mca.parse_dividends("RELIANCE", RELIANCE_DATA["dividends"])
        assert len(rows) == 2
        r = rows[0]
        assert r["action_type"] == "dividend"
        assert r["amount"] == pytest.approx(6.00)
        assert r["record_date"] == "2026-06-05"   # "05 Jun, 2026" parsed
        assert r["announce_date"] == "2026-04-24"
        assert r["ratio_factor"] is None

    def test_falls_back_to_dividend_per_when_amount_string_missing(self):
        rows = mca.parse_dividends("X", [{"announce_date": "2026-01-01",
                                            "dividend_type": "Interim", "dividend_per": 20}])
        assert rows[0]["amount"] == pytest.approx(20.0)


class TestParseBonus:
    def test_one_one_bonus_factor_is_one_half(self):
        rows = mca.parse_bonus("RELIANCE", RELIANCE_DATA["bonus"])
        r = rows[0]
        assert r["action_type"] == "bonus"
        assert r["ratio_factor"] == pytest.approx(0.5)
        assert r["ratio_text"] == "1:1"
        # prefers the true ex-date (exbonus_date) over MC's record_date
        assert r["record_date"] == "2024-10-28"

    def test_two_one_bonus_factor_is_one_third(self):
        rows = mca.parse_bonus("X", [{"announcement_date": "2024-01-01", "existing_ratio": 1,
                                        "offered_ratio": 2, "record_date": "2024-02-01",
                                        "bonus_ratio": "2:1"}])
        assert rows[0]["ratio_factor"] == pytest.approx(1 / 3)


class TestParseSplits:
    def test_nestleind_1_to_10_split_matches_documented_factor(self):
        # ohlcv_adjust.py's own docstring pins NESTLEIND's real 2024-01-05 factor at 0.0983
        # (a small real intraday return layered on the clean 1:10 = 0.1 ratio) -- this
        # authoritative source should land on the CLEAN 0.1, which is exactly what
        # snap_to_ratio() in ohlcv_adjust.py would resolve the heuristic's 0.0983 to.
        rows = mca.parse_splits("NESTLEIND", NESTLEIND_SPLIT["splits"])
        r = rows[0]
        assert r["action_type"] == "split"
        assert r["ratio_factor"] == pytest.approx(0.1)
        assert r["record_date"] == "2024-01-05"   # exsplit_date "05 Jan, 2024" parsed
        assert r["ratio_text"] == "10:1"

    def test_missing_face_values_yields_no_factor_not_a_crash(self):
        rows = mca.parse_splits("X", [{"announce_date": "2024-01-01", "record_date": "2024-01-02"}])
        assert rows[0]["ratio_factor"] is None


class TestParseRights:
    def test_rights_never_gets_a_ratio_factor(self):
        """Rights adjustment is price-dependent (theoretical ex-rights price), not a clean
        multiplicative ratio -- ratio_factor must stay NULL, per the module's own documented
        reasoning, or a consumer could silently misuse it as if it meant the same thing as a
        bonus/split factor."""
        rows = mca.parse_rights("RELIANCE", RELIANCE_DATA["rights"])
        r = rows[0]
        assert r["ratio_factor"] is None
        assert r["ratio_text"] == "1:15"
        assert r["amount"] == pytest.approx(1247.0)   # premium
        assert r["record_date"] == "2020-05-13"        # exrights_date preferred over record_date


class TestParsePayload:
    def test_reliance_payload_yields_dividend_bonus_rights_no_splits(self):
        rows = mca.parse_payload("RELIANCE", RELIANCE_DATA)
        by_type = {}
        for r in rows:
            by_type.setdefault(r["action_type"], []).append(r)
        assert set(by_type) == {"dividend", "bonus", "rights"}
        assert "split" not in by_type

    def test_absent_category_key_does_not_crash(self):
        assert mca.parse_payload("X", {}) == []


class TestSchemaAndStorage:
    def test_ensure_schema_creates_table(self):
        con = pg_memory_conn()
        mca.ensure_schema(con)
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert "stock_corporate_action_history" in tables

    def test_upsert_is_idempotent(self):
        con = pg_memory_conn()
        mca.ensure_schema(con)
        rows = mca.parse_payload("RELIANCE", RELIANCE_DATA)
        assert mca.store(con, rows) == len(rows)
        assert mca.store(con, rows) == len(rows)   # re-store: no duplicates
        count = con.execute("SELECT COUNT(*) FROM stock_corporate_action_history").fetchone()[0]
        assert count == len(rows)

    def test_different_symbols_with_same_ratio_never_collide(self):
        """The PK is (symbol, action_type, event_key) -- two different stocks declaring the
        same 1:1 bonus on the same date must both be stored, not overwrite each other."""
        con = pg_memory_conn()
        mca.ensure_schema(con)
        rows_a = mca.parse_bonus("AAA", RELIANCE_DATA["bonus"])
        rows_b = mca.parse_bonus("BBB", RELIANCE_DATA["bonus"])
        mca.store(con, rows_a)
        mca.store(con, rows_b)
        count = con.execute("SELECT COUNT(*) FROM stock_corporate_action_history").fetchone()[0]
        assert count == 2
