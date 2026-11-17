"""Unit tests for investsights_earnings_calendar_fetcher.py (AF-20261115-01)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_earnings_calendar_fetcher as ecf  # noqa: E402

UNIVERSE = {"TCS", "WIMPLAST"}
RAW = {"symbol": "TCS.NS", "date": "2026-12-01", "eps_estimated": 31.5, "revenue_estimated": None,
       "is_announced": False}


def _row(**over):
    return ecf.parse_row({**RAW, **over}, UNIVERSE, "2026-11-17")


class TestParseRow:
    def test_nse_row_resolves_and_keeps_the_estimate(self):
        r = _row()
        assert (r["symbol"], r["exchange"], r["provider_symbol"]) == ("TCS", "NSE", "TCS.NS")
        assert r["eps_estimated"] == 31.5 and r["revenue_estimated"] is None
        assert r["result_date"] == "2026-12-01" and r["snapshot_date"] == "2026-11-17"

    def test_ticker_outside_the_universe_is_kept_but_unresolved(self):
        r = _row(symbol="512485.NS")
        assert r["symbol"] is None and r["provider_symbol"] == "512485.NS"

    def test_bse_suffix_is_recorded(self):
        assert _row(symbol="WIMPLAST.BO")["exchange"] == "BSE"

    def test_non_finite_estimate_is_null_not_zero(self):
        assert _row(eps_estimated=float("nan"))["eps_estimated"] is None

    def test_row_without_symbol_or_date_is_dropped(self):
        assert _row(symbol="") is None
        assert _row(date=None) is None
        assert _row(date="17 Nov 2026") is None


class TestStoreIsAppendOnly:
    def test_a_later_write_never_rewrites_the_same_snapshot_day(self):
        conn = pg_memory_conn()
        ecf.ensure_schema(conn)
        ecf.store(conn, [_row()])
        ecf.store(conn, [_row(eps_estimated=99.0)])          # same day, same key: ignored
        ecf.store(conn, [ecf.parse_row(RAW, UNIVERSE, "2026-11-18")])   # next day: new row
        rows = conn.execute("SELECT snapshot_date, eps_estimated FROM earnings_calendar_snapshots "
                            "ORDER BY snapshot_date").fetchall()
        assert [(str(r[0])[:10], r[1]) for r in rows] == [("2026-11-17", 31.5), ("2026-11-18", 31.5)]
