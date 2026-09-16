"""Live-datasource test for tickertape_deals_fetcher.py (CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

Beyond the standard fetch -> own parser -> own writer -> ML-usability round trip, this pins the
two endpoint quirks that would each fail SILENTLY:

  * `type=block` / `type=bulk` are ignored -- both return the identical mixed set. Code that
    trusts the param would believe it had block deals only.
  * `skip` is ignored while `offset` works. A pagination loop built on `skip` would re-fetch
    page 1 forever, looking like progress while storing nothing new.
"""
import os
import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import tickertape_deals_fetcher as ttd
from live_datasource_helpers import (
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_numeric_and_finite,
)


def _session():
    s = requests.Session()
    s.headers.update(ttd.HEADERS)
    return s


@pytest.mark.live_datasource
class TestTickertapeDealsLiveDataSource:
    def test_real_fetch_parses_and_carries_pct_of_float(self):
        items = ttd.fetch_page(_session(), offset=0, count=50)
        assert_non_empty_response(items, "tickertape_deals_fetcher.fetch_page()")

        rows = [d for d in (ttd.parse_deal(i) for i in items) if d]
        assert_non_empty_response(rows, "parse_deal()")

        # pct_transacted is the entire reason this source was chosen over NSE's own feed.
        # If it ever stops arriving, this fetcher has no purpose and must fail loudly.
        with_pct = [r for r in rows if r["pct_transacted"] is not None]
        assert len(with_pct) / len(rows) > 0.8, (
            f"only {len(with_pct)}/{len(rows)} deals carry pctTransacted -- the field this "
            "fetcher exists for"
        )
        for r in with_pct[:10]:
            assert_looks_like_ticker(r["symbol"], "block_deals.symbol")
            assert_numeric_and_finite(r["pct_transacted"], "pct_transacted")
            assert 0 < r["pct_transacted"] <= 100, (
                f"{r['symbol']}: {r['pct_transacted']}% of float is not a real percentage"
            )
            assert r["trade_type"] in ("buy", "sell"), r["trade_type"]

    def test_offset_paginates_but_skip_does_not(self):
        """Verified live 2026-07-31. `skip` returns page 1 again; a loop built on it would
        silently never advance."""
        s = _session()
        p0 = ttd.fetch_page(s, offset=0, count=50)
        p1 = ttd.fetch_page(s, offset=50, count=50)
        assert p0 and p1
        assert p0[0]["_id"] != p1[0]["_id"], "offset did not advance the page"

        r = requests.get(ttd.API, params={"count": 50, "skip": 50},
                         headers=ttd.HEADERS, timeout=30)
        skipped = (r.json().get("data") or {}).get("items") or []
        assert skipped and skipped[0]["_id"] == p0[0]["_id"], (
            "`skip` appears to paginate now -- re-check which param the fetcher should use"
        )

    def test_type_param_is_ignored_so_category_must_come_from_the_row(self):
        """Asking for type=block still returns non-Block rows -- that alone proves the param
        does not filter, and unlike comparing _id lists it is immune to the feed shifting
        between two calls (observed: 48/50 overlap, because new deals keep arriving)."""
        r = requests.get(ttd.API, params={"count": 50, "offset": 0, "type": "block"},
                         headers=ttd.HEADERS, timeout=30)
        items = (r.json().get("data") or {}).get("items") or []
        assert items, "no rows returned for type=block"

        cats = {i.get("category") for i in items}
        assert cats - {"Block"}, (
            f"`type` now appears to filter (only got {cats}) -- re-check whether the fetcher "
            "should use it instead of the row's category"
        )
        # The feed carries ~10 flavours of insider filing alongside the deals; assert the
        # parser DROPS them rather than that they are absent.
        assert cats & ttd.DEAL_CATEGORIES, f"no bulk/block rows at all in {cats}"
        kept = {d["category"] for d in (ttd.parse_deal(i) for i in items) if d}
        assert kept <= ttd.DEAL_CATEGORIES, f"insider rows leaked into block_deals: {kept}"

    def test_stored_rows_are_ml_usable(self):
        items = ttd.fetch_page(_session(), offset=0, count=50)
        rows = [d for d in (ttd.parse_deal(i) for i in items) if d]
        con = pg_memory_conn()
        ttd.ensure_schema(con)
        assert ttd.store(con, rows) == len(rows)

        sym, date, pct, val, side = con.execute(
            "SELECT symbol, date, pct_transacted, value_cr, trade_type FROM block_deals "
            "WHERE pct_transacted IS NOT NULL LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(sym, "symbol")
        assert len(date) == 10 and date[4] == "-", f"date not ISO: {date}"
        assert_numeric_and_finite(pct, "pct_transacted")
        assert_numeric_and_finite(val, "value_cr")
        # Rupees would be ~1e8 here; crore keeps it in a sane range.
        assert 0 < val < 100000, f"value_cr={val} looks like raw rupees, not crore"
        assert side in ("buy", "sell")
