"""Regression tests for ndtv_fno_basis_fetcher.py.

Fixture shaped from a real payload captured live on 2026-08-07.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

import ndtv_fno_basis_fetcher as nfb

REAL_PAYLOAD = {
    "responseCode": 200,
    "data": {
        "basis": 5.2, "symbol": "RELIANCE", "spot-price": 1318.8,
        "1m-future": 1324, "2m-future": 1333, "roll-spread": 9,
        "roll-over-percentage": 16.63, "open-interest": 217909,
        "open-interest-change-percentage": -0.13, "put-call-ratio": 0.84,
    },
    "broadcasted-at": "2026-08-07T09:40:09.480208041",
}

NO_CONTRACT_PAYLOAD = {
    "responseCode": 200,
    "data": {"basis": 0, "symbol": None, "spot-price": 0, "1m-future": 0, "2m-future": 0,
              "roll-spread": 0, "roll-over-percentage": 0, "open-interest": 0,
              "open-interest-change-percentage": 0, "put-call-ratio": 0},
    "broadcasted-at": "2026-08-07T09:40:09.480208041",
}


class TestParseSummary:
    def test_maps_a_real_payload(self):
        r = nfb.parse_summary("RELIANCE", REAL_PAYLOAD)
        assert r["symbol"] == "RELIANCE"
        assert r["spot_price"] == pytest.approx(1318.8)
        assert r["future_1m"] == pytest.approx(1324)
        assert r["basis"] == pytest.approx(5.2)
        assert r["rollover_pct"] == pytest.approx(16.63)
        assert r["put_call_ratio"] == pytest.approx(0.84)
        assert r["broadcasted_at"] == "2026-08-07T09:40:09.480208041"
        assert r["source"] == "ndtvprofit"

    def test_no_active_contract_is_dropped_not_stored_as_zeros(self):
        """A null data.symbol means the stock has no live F&O contract right now (module
        docstring, confirmed live for DRCSYSTEMS) -- must be skipped, not stored as a row of
        misleading zeros that would look like real (bearish/flat) basis data."""
        assert nfb.parse_summary("DRCSYSTEMS", NO_CONTRACT_PAYLOAD) is None

    def test_nan_numeric_becomes_none(self):
        bad = {**REAL_PAYLOAD, "data": {**REAL_PAYLOAD["data"], "basis": float("nan")}}
        r = nfb.parse_summary("RELIANCE", bad)
        assert r["basis"] is None

    def test_missing_broadcasted_at_does_not_crash(self):
        bad = {k: v for k, v in REAL_PAYLOAD.items() if k != "broadcasted-at"}
        r = nfb.parse_summary("RELIANCE", bad)
        assert r["broadcasted_at"] is None


class TestFetchOne:
    def test_non_200_response_code_returns_none(self):
        class FakeResp:
            def raise_for_status(self):
                pass
            def json(self):
                return {"responseCode": 500}
        class FakeSession:
            def get(self, *a, **k):
                return FakeResp()
        assert nfb.fetch_one(FakeSession(), "RELIANCE") is None

    def test_malformed_envelope_returns_none(self):
        class FakeResp:
            def raise_for_status(self):
                pass
            def json(self):
                return ["not", "a", "dict"]
        class FakeSession:
            def get(self, *a, **k):
                return FakeResp()
        assert nfb.fetch_one(FakeSession(), "RELIANCE") is None


class TestSchemaAndStorage:
    def test_ensure_schema_and_store_round_trip(self):
        con = pg_memory_conn()
        nfb.ensure_schema(con)
        row = nfb.parse_summary("RELIANCE", REAL_PAYLOAD)
        row["date"] = "2026-08-07"
        assert nfb.store(con, [row]) == 1
        symbol, date, basis = con.execute(
            "SELECT symbol, date, basis FROM ndtv_fno_basis LIMIT 1"
        ).fetchone()
        assert symbol == "RELIANCE"
        assert date == "2026-08-07"
        assert basis == pytest.approx(5.2)

    def test_upsert_is_idempotent(self):
        con = pg_memory_conn()
        nfb.ensure_schema(con)
        row = nfb.parse_summary("RELIANCE", REAL_PAYLOAD)
        row["date"] = "2026-08-07"
        assert nfb.store(con, [row]) == 1
        assert nfb.store(con, [row]) == 1
        count = con.execute("SELECT COUNT(*) FROM ndtv_fno_basis").fetchone()[0]
        assert count == 1

    def test_upsert_updates_on_new_broadcast(self):
        """Same (symbol, date) re-fetched later the same day (e.g. a job retry) must UPDATE
        the row with the newer broadcast, not duplicate it."""
        con = pg_memory_conn()
        nfb.ensure_schema(con)
        row1 = nfb.parse_summary("RELIANCE", REAL_PAYLOAD)
        row1["date"] = "2026-08-07"
        nfb.store(con, [row1])
        updated_payload = {**REAL_PAYLOAD, "data": {**REAL_PAYLOAD["data"], "basis": 8.9}}
        row2 = nfb.parse_summary("RELIANCE", updated_payload)
        row2["date"] = "2026-08-07"
        nfb.store(con, [row2])
        count, basis = con.execute(
            "SELECT COUNT(*), MAX(basis) FROM ndtv_fno_basis"
        ).fetchone()
        assert count == 1
        assert basis == pytest.approx(8.9)

    def test_store_empty_list_is_a_noop(self):
        con = pg_memory_conn()
        nfb.ensure_schema(con)
        assert nfb.store(con, []) == 0
