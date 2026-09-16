"""Regression tests for investsights_corporate_actions_fetcher.py.

Fixture shaped from a real payload captured live on 2026-08-07.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_corporate_actions_fetcher as ica


TATAPOWER_ROW = {
    "symbol": "TATAPOWER", "company_name": "The Tata Power Company Limited",
    "dividend_per_share": 2.5, "record_date": "2026-06-23", "ex_date": None,
    "filing_date": "2026-05-12",
    "headline": "Tata Power's Board approved Q4 & FY26 results...",
    "category": "board_meeting|dividend|results",
    "source_url": "https://nsearchives.nseindia.com/corporate/VPTPCL_12052026164727_Outcome.pdf",
    "upcoming": False,
}

CINEVISTA_ROW = {
    "symbol": "CINEVISTA", "company_name": "Cinevista Limited",
    "dividend_per_share": None, "record_date": "2026-06-22", "ex_date": None,
    "filing_date": "2026-05-06", "headline": "Board approves Q4 & FY26 results...",
    "category": "board_meeting|results|regulatory",
    "source_url": "https://nsearchives.nseindia.com/corporate/CINEVISTA_06052026163958_Reg30_OCR.pdf",
    "upcoming": False,
}

UNIVERSE = {"TATAPOWER", "CINEVISTA"}


class TestParseAction:
    def test_real_row_parses_with_null_ex_date_intact(self):
        row = ica.parse_action(TATAPOWER_ROW, UNIVERSE)
        assert row["symbol"] == "TATAPOWER"
        assert row["ex_date"] is None            # genuinely absent upstream, not a parse bug
        assert row["record_date"] == "2026-06-23"
        assert row["dividend_per_share"] == pytest.approx(2.5)
        assert row["source_url"].startswith("https://nsearchives.nseindia.com/")

    def test_symbol_not_in_universe_is_dropped(self):
        row = {**TATAPOWER_ROW, "symbol": "NOTAREALSYMBOL123"}
        assert ica.parse_action(row, UNIVERSE) is None

    def test_missing_source_url_is_dropped(self):
        """source_url is the only stable dedup key this feed offers -- a row without one
        can never be safely upserted, so it must be skipped, not stored with a fabricated key."""
        row = {**TATAPOWER_ROW, "source_url": ""}
        assert ica.parse_action(row, UNIVERSE) is None

    def test_lowercase_symbol_from_source_is_normalized_uppercase(self):
        row = {**TATAPOWER_ROW, "symbol": "tatapower"}
        parsed = ica.parse_action(row, UNIVERSE)
        assert parsed["symbol"] == "TATAPOWER"

    def test_null_dividend_per_share_stays_null_not_zero(self):
        row = ica.parse_action(CINEVISTA_ROW, UNIVERSE)
        assert row["dividend_per_share"] is None


class TestSchemaAndStorage:
    def test_ensure_schema_creates_table(self):
        con = pg_memory_conn()
        ica.ensure_schema(con)
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert "nse_filed_corporate_actions" in tables

    def test_source_url_upsert_is_idempotent(self):
        con = pg_memory_conn()
        ica.ensure_schema(con)
        row = ica.parse_action(TATAPOWER_ROW, UNIVERSE)
        assert ica.store(con, [row]) == 1
        assert ica.store(con, [row]) == 1   # re-store: no duplicate
        count = con.execute("SELECT COUNT(*) FROM nse_filed_corporate_actions").fetchone()[0]
        assert count == 1

    def test_two_distinct_filings_both_stored(self):
        con = pg_memory_conn()
        ica.ensure_schema(con)
        rows = [ica.parse_action(TATAPOWER_ROW, UNIVERSE), ica.parse_action(CINEVISTA_ROW, UNIVERSE)]
        assert ica.store(con, rows) == 2


class TestRunReturnCode:
    def test_empty_actions_list_is_a_failure(self, monkeypatch):
        """An empty actions list is the real outage signal -- distinct from actions existing
        but all failing to resolve to a known symbol (a coverage question, not an outage)."""
        monkeypatch.setattr(ica, "fetch_filed_actions", lambda *a, **k: [])
        monkeypatch.setattr(ica, "connect", lambda: pg_memory_conn())
        monkeypatch.setattr(ica, "load_nse_universe", lambda: UNIVERSE)
        assert ica.run() == 1

    def test_actions_present_but_none_resolve_is_still_success(self, monkeypatch):
        monkeypatch.setattr(ica, "fetch_filed_actions",
                             lambda *a, **k: [{**TATAPOWER_ROW, "symbol": "NOPE"}])
        monkeypatch.setattr(ica, "connect", lambda: pg_memory_conn())
        monkeypatch.setattr(ica, "load_nse_universe", lambda: UNIVERSE)
        assert ica.run() == 0
