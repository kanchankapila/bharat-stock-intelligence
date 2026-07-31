"""Regression tests for fii_dii_history_fetcher.py.

The load-bearing logic here is the ERA-AWARE column mapping. The investsights endpoint reuses
`fii_net` for two different quantities (cash-equity net in the recent era, all-segment net
dominated by derivatives in the historical era) and its `dii_net` is mutual-funds-only rather
than NSE's DII aggregate. Both facts were established by live measurement on 2026-07-31 (see
the module docstring); these tests pin the exact mapping so a future "simplification" that
just reads `fii_net` straight through fails loudly instead of silently writing a 15x-inflated
derivatives figure into the column every consumer reads as cash equity.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import fii_dii_history_fetcher as fdh


# Real shapes captured live from the endpoint on 2026-07-31.
RECENT_ROW = {
    "trade_date": "2026-07-30",
    "fii_buy": 17431.96, "fii_sell": 13808.45, "fii_net": 3623.51,
    "fii_equity": None, "fii_debt": None, "fii_derivatives": None,
    "dii_buy": 17979.63, "dii_sell": 19843.66, "dii_net": -1864.03,
    "mf_equity": None, "mf_debt": None, "mf_derivatives": None, "mf_total": None,
}
# 2024-09-26: the worst observed case -- raw fii_net is 132,159 Cr while true cash equity
# is 8,538 Cr, because fii_derivatives is 123,443 Cr.
HISTORICAL_ROW = {
    "trade_date": "2024-09-26",
    "fii_buy": None, "fii_sell": None, "fii_net": 132159.2,
    "fii_equity": 8537.6, "fii_debt": 178.6, "fii_derivatives": 123443.0,
    "dii_buy": None, "dii_sell": None, "dii_net": -7281.3,
    "mf_equity": -3143.0, "mf_debt": 1288.3, "mf_derivatives": -5426.6, "mf_total": -7281.3,
}
# 2026-03-25: a real "transitional" row carrying BOTH the buy/sell pair and the segment
# breakdown. Here fii_net (-1508.89) is cash equity == buy - sell, while equity+debt+deriv
# sums to 4242.8 -- so buy/sell presence, not the mere existence of segment fields, is what
# decides the era.
TRANSITIONAL_ROW = {
    "trade_date": "2026-03-25",
    "fii_buy": 13473.13, "fii_sell": 14982.02, "fii_net": -1508.89,
    "fii_equity": -1565.6, "fii_debt": 143.6, "fii_derivatives": 5664.8,
    "dii_buy": 21459.9, "dii_sell": 16286.89, "dii_net": 5173.01,
    "mf_equity": None, "mf_debt": None, "mf_derivatives": None, "mf_total": None,
}


class TestEraAwareMapping:
    def test_recent_era_fii_net_is_cash_equity_from_buy_minus_sell(self):
        r = fdh.parse_row(RECENT_ROW)
        assert r["fii_net"] == pytest.approx(3623.51)
        assert r["fii_buy"] == pytest.approx(17431.96)
        # No all-segment figure exists in this era -- must not be invented.
        assert r["fii_net_all_segments"] is None

    def test_historical_era_fii_net_is_fii_equity_NOT_raw_fii_net(self):
        """The whole point of this module. Raw fii_net is 15x the cash-equity number."""
        r = fdh.parse_row(HISTORICAL_ROW)
        assert r["fii_net"] == pytest.approx(8537.6), (
            "historical fii_net must map to fii_equity (cash equity), not the raw "
            "all-segment fii_net"
        )
        assert r["fii_net"] != pytest.approx(132159.2)
        assert r["fii_net_all_segments"] == pytest.approx(132159.2)

    def test_historical_all_segments_reconstructed_when_raw_net_missing(self):
        raw = dict(HISTORICAL_ROW, fii_net=None)
        r = fdh.parse_row(raw)
        assert r["fii_net_all_segments"] == pytest.approx(8537.6 + 178.6 + 123443.0)

    def test_historical_dii_net_is_left_null_not_filled_with_mf(self):
        """mf_total is mutual funds only; dii_net is the NSE DII aggregate. Measured median
        disagreement on the live overlap was 3,786 Cr, agreeing within 1 Cr on 0/576 rows."""
        r = fdh.parse_row(HISTORICAL_ROW)
        assert r["dii_net"] is None, "MF flow must never be written into the DII column"
        assert r["mf_total"] == pytest.approx(-7281.3)
        assert r["mf_equity"] == pytest.approx(-3143.0)

    def test_recent_era_dii_net_is_accepted_when_backed_by_buy_sell(self):
        r = fdh.parse_row(RECENT_ROW)
        assert r["dii_net"] == pytest.approx(-1864.03)

    def test_transitional_row_keeps_cash_equity_AND_derives_all_segments(self):
        """21 real rows (verified live 2026-07-31) carry BOTH the buy/sell pair and the
        segment breakdown. There fii_net is cash equity (-1508.89 == buy-sell, NOT the
        4242.8 that equity+debt+deriv sums to), so the all-segment figure must be summed
        rather than read off fii_net -- and must not be dropped just because the row also
        has a buy/sell pair. Caught by the live_datasource test, not by construction."""
        r = fdh.parse_row(TRANSITIONAL_ROW)
        assert r["fii_net"] == pytest.approx(-1508.89)
        assert r["fii_net_all_segments"] == pytest.approx(-1565.6 + 143.6 + 5664.8)
        assert r["fii_derivatives"] == pytest.approx(5664.8)
        assert r["dii_net"] == pytest.approx(5173.01)

    def test_era_is_decided_by_buy_sell_presence_not_by_date(self):
        """There is no era flag in the payload; presence of the buy/sell pair is the only
        discriminator. A historical-shaped row with a recent date must still map historically."""
        raw = dict(HISTORICAL_ROW, trade_date="2026-07-01")
        r = fdh.parse_row(raw)
        assert r["fii_net"] == pytest.approx(8537.6)
        assert r["fii_net_all_segments"] == pytest.approx(132159.2)


class TestRowHygiene:
    def test_malformed_date_is_rejected(self):
        assert fdh.parse_row(dict(RECENT_ROW, trade_date="30-Jul-2026")) is None
        assert fdh.parse_row(dict(RECENT_ROW, trade_date="")) is None

    def test_all_null_row_is_dropped(self):
        empty = {"trade_date": "2020-01-01"}
        assert fdh.parse_row(empty) is None

    def test_non_finite_values_become_none_not_nan(self):
        """A NaN in a REAL column passes every null/coverage check in this repo but poisons
        every downstream mean."""
        r = fdh.parse_row(dict(HISTORICAL_ROW, fii_debt="NaN", fii_derivatives="not a number"))
        assert r["fii_debt"] is None
        assert r["fii_derivatives"] is None

    def test_parse_all_skips_bad_rows_without_failing_the_batch(self):
        rows = fdh.parse_all([RECENT_ROW, {"trade_date": "junk"}, HISTORICAL_ROW])
        assert len(rows) == 2


def _mem_db():
    con = sqlite3.connect(":memory:")
    con.execute("""
        CREATE TABLE fii_dii_flow (
            date TEXT PRIMARY KEY, fii_buy REAL, fii_sell REAL, fii_net REAL,
            dii_buy REAL, dii_sell REAL, dii_net REAL, source TEXT, fetched_at TEXT
        )
    """)
    con.commit()
    return con


class TestStore:
    def test_ensure_schema_adds_segment_columns_and_is_idempotent(self):
        con = _mem_db()
        fdh.ensure_schema(con)
        fdh.ensure_schema(con)  # second run must not raise
        cols = {r[1] for r in con.execute("PRAGMA table_info(fii_dii_flow)")}
        for c in fdh.SEGMENT_COLS:
            assert c in cols

    def test_inserts_missing_dates(self):
        con = _mem_db()
        fdh.ensure_schema(con)
        stats = fdh.store(con, fdh.parse_all([RECENT_ROW, HISTORICAL_ROW]))
        assert stats["inserted"] == 2
        n = con.execute("SELECT COUNT(*) FROM fii_dii_flow").fetchone()[0]
        assert n == 2

    def test_never_clobbers_an_existing_value_by_default(self):
        """Default is gap-fill so this can run alongside the NSE/tradebrains sources in any
        order without one silently rewriting the other's numbers."""
        con = _mem_db()
        fdh.ensure_schema(con)
        con.execute(
            "INSERT INTO fii_dii_flow (date, fii_net, dii_net, source) VALUES (?,?,?,?)",
            ("2024-09-26", 9999.0, 111.0, "tradebrains"),
        )
        con.commit()
        fdh.store(con, fdh.parse_all([HISTORICAL_ROW]))
        row = con.execute(
            "SELECT fii_net, dii_net, source, fii_derivatives FROM fii_dii_flow WHERE date=?",
            ("2024-09-26",),
        ).fetchone()
        assert row[0] == 9999.0, "existing fii_net must survive"
        assert row[1] == 111.0, "existing dii_net must survive"
        assert row[2] == "tradebrains", "provenance of an existing row must not be rewritten"
        assert row[3] == pytest.approx(123443.0), "new segment column should still be filled"

    def test_overwrite_flag_lets_this_source_win(self):
        con = _mem_db()
        fdh.ensure_schema(con)
        con.execute("INSERT INTO fii_dii_flow (date, fii_net) VALUES (?,?)", ("2024-09-26", 9999.0))
        con.commit()
        fdh.store(con, fdh.parse_all([HISTORICAL_ROW]), overwrite=True)
        v = con.execute("SELECT fii_net FROM fii_dii_flow WHERE date=?", ("2024-09-26",)).fetchone()[0]
        assert v == pytest.approx(8537.6)

    def test_dry_run_writes_nothing_but_still_reports(self):
        con = _mem_db()
        fdh.ensure_schema(con)
        stats = fdh.store(con, fdh.parse_all([RECENT_ROW, HISTORICAL_ROW]), dry_run=True)
        assert stats["inserted"] == 2
        assert con.execute("SELECT COUNT(*) FROM fii_dii_flow").fetchone()[0] == 0

    def test_rerun_is_idempotent(self):
        con = _mem_db()
        fdh.ensure_schema(con)
        rows = fdh.parse_all([RECENT_ROW, HISTORICAL_ROW])
        fdh.store(con, rows)
        stats = fdh.store(con, rows)
        assert stats["inserted"] == 0
        assert stats["filled"] == 0
        assert stats["unchanged"] == 2
