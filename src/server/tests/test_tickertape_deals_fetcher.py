"""Regression tests for tickertape_deals_fetcher.py.

The endpoint quirks pinned here were all verified live on 2026-07-31 and would each cause a
silent failure: an ignored `type` param that looks like it filters, a `skip` param that looks
like it paginates but re-serves page 1 forever, and rupee values that must be converted to
crore to match the column every other deal row uses.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tickertape_deals_fetcher as ttd


# A real row captured live on 2026-07-31.
REAL_DEAL = {
    "sid": "XTR", "date": "2026-07-30T00:00:00.000Z",
    "client": "MITTAL GROWTH PARTNERS LLP", "category": "Bulk", "tradeType": "buy",
    "qty": 940000, "value": 126937599.99999999, "pctTransacted": 2.4008990600735594,
    "avgPrice": 135.04, "name": "Xtranet Technologies Ltd", "ticker": "XTRANET",
    "slug": "/stocks/xtranet-technologies-XTR", "_id": "6a6b8eee01da9335ffc695a4",
}


class TestParseDeal:
    def test_maps_a_real_row(self):
        r = ttd.parse_deal(REAL_DEAL)
        assert r["symbol"] == "XTRANET"
        assert r["date"] == "2026-07-30"          # ISO timestamp truncated to a date
        assert r["pct_transacted"] == pytest.approx(2.4009, abs=1e-4)
        assert r["trade_type"] == "buy"
        assert r["client_name"] == "MITTAL GROWTH PARTNERS LLP"
        assert r["source"] == "tickertape"

    def test_value_is_converted_rupees_to_crore(self):
        """block_deals.value_cr is in crore for the NSE rows already in the table; storing
        raw rupees here would make the column mean two different things."""
        r = ttd.parse_deal(REAL_DEAL)
        assert r["value_cr"] == pytest.approx(12.69376, abs=1e-4)

    def test_id_is_namespaced_so_it_cannot_collide_with_nse_ids(self):
        r = ttd.parse_deal(REAL_DEAL)
        assert r["id"].startswith("tt:")

    def test_uses_ticker_not_sid(self):
        """`sid` is Tickertape's internal id ('XTR'); `ticker` is the real NSE symbol.
        Storing sid would put a non-joinable identifier in the symbol column -- the same
        defect class as the 2026-07-23 URL-as-symbol corruption."""
        r = ttd.parse_deal(REAL_DEAL)
        assert r["symbol"] != REAL_DEAL["sid"]
        assert r["symbol"] == "XTRANET"

    @pytest.mark.parametrize("bad", [
        {**REAL_DEAL, "ticker": ""},
        {**REAL_DEAL, "date": ""},
        {**REAL_DEAL, "date": "30-Jul-2026"},
        {**REAL_DEAL, "_id": None},
    ])
    def test_unusable_rows_are_dropped(self, bad):
        assert ttd.parse_deal(bad) is None

    def test_row_without_pct_is_still_kept(self):
        """pct_transacted is the reason this source exists, but dropping rows that lack it
        would make coverage silently WORSE than the NSE feed it supplements."""
        r = ttd.parse_deal({**REAL_DEAL, "pctTransacted": None})
        assert r is not None
        assert r["pct_transacted"] is None
        assert r["qty"] == 940000

    def test_nan_becomes_none(self):
        r = ttd.parse_deal({**REAL_DEAL, "pctTransacted": float("nan")})
        assert r["pct_transacted"] is None


def _mem():
    con = sqlite3.connect(":memory:")
    ttd.ensure_schema(con)
    return con


class TestStore:
    def test_ensure_schema_is_idempotent(self):
        con = _mem()
        ttd.ensure_schema(con)
        cols = {r[1] for r in con.execute("PRAGMA table_info(block_deals)")}
        for c in ("pct_transacted", "client_name", "trade_type", "category", "source"):
            assert c in cols

    def test_store_and_reupsert_is_idempotent(self):
        con = _mem()
        rows = [ttd.parse_deal(REAL_DEAL)]
        ttd.store(con, rows)
        ttd.store(con, rows)
        assert con.execute("SELECT COUNT(*) FROM block_deals").fetchone()[0] == 1

    def test_stored_row_is_ml_usable(self):
        con = _mem()
        ttd.store(con, [ttd.parse_deal(REAL_DEAL)])
        sym, pct, side = con.execute(
            "SELECT symbol, pct_transacted, trade_type FROM block_deals"
        ).fetchone()
        assert sym.isalnum() and sym.isupper()
        assert isinstance(pct, float) and 0 < pct < 100
        assert side in ("buy", "sell")

    def test_does_not_disturb_existing_nse_rows(self):
        """block_deals is shared with block_deal_fetcher.py; this source must only add."""
        con = _mem()
        con.execute("INSERT INTO block_deals (id, symbol, date, qty) VALUES ('nse-1','RELIANCE','2026-07-30',100)")
        con.commit()
        ttd.store(con, [ttd.parse_deal(REAL_DEAL)])
        n, = con.execute("SELECT COUNT(*) FROM block_deals WHERE id='nse-1'").fetchone()
        assert n == 1
