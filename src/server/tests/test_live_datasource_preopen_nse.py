"""Live-datasource test for preopen_fetcher.py's NSE per-stock pre-open path
(fetch_nse_preopen), see CLAUDE.md's "Adding a New Data Source" mandatory rule.

TestPreopenFetcher in test_live_datasource_feature_matrix_fetchers.py already covers this
file's MoneyControl GIFT-Nifty/global-indices path (fetch_section). It does NOT cover
fetch_nse_preopen -- the higher-blast-radius half, since it writes ~2,150 rows/day into
preopen_stock_snapshot and backfills technical_signals for the whole F&O+Nifty universe.
This closes that gap and, per data-sources.md's live_datasource mandate, exercises the
fetcher's OWN parsing and OWN DB-write function end to end, not a hand-rolled reimplementation.

Added 2026-09-04 alongside total_traded_volume: NSE's pre-open response carries the actual
MATCHED quantity at the call-auction clearing price (totalTradedVolume/finalQuantity),
distinct from total_buy_qty/total_sell_qty (unmatched order-book depth) that this fetcher
already wrote. The new column is the reason this test exists now, not incidentally covered.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from pg_test_support import pg_memory_conn  # noqa: E402
import preopen_fetcher as pf  # noqa: E402
from live_datasource_helpers import assert_numeric_and_finite  # noqa: E402


def _make_test_conn():
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT)")
    conn.commit()
    return conn


@pytest.mark.live_datasource
class TestNsePreopenFetcherLiveDataSource:
    def test_real_endpoint_returns_the_whole_market(self):
        """key=ALL is the one-call bulk path (data-sources.md's bulk-endpoint pattern) --
        assert it actually behaves like one, not like a single-symbol or empty response."""
        sess = pf._nse_session()
        raw = pf._fetch_nse_preopen_url(sess, pf.NSE_PREOPEN_ALL)
        assert isinstance(raw, list), f"expected a list, got {type(raw)}"
        assert len(raw) > 500, (
            f"key=ALL returned only {len(raw)} items -- expected 2,000+ for the whole equity "
            f"market. Either NSE changed the response shape or this call is being blocked."
        )

    def test_own_write_path_produces_ml_usable_rows_with_real_volume(self):
        """Writes through fetch_nse_preopen() -- the SAME function ml-daily-ops/preopen-snapshot
        calls in production -- into a throwaway DB, then reads the rows back and asserts they
        are usable: identifiers look like real tickers, numeric columns are real finite
        numbers, and total_traded_volume specifically is populated (not just carried through
        as a column with no data -- the reason this test file exists)."""
        conn = _make_test_conn()
        n = pf.fetch_nse_preopen(conn)
        assert n > 500, f"fetch_nse_preopen() upserted only {n} rows -- expected 2,000+"

        cur = conn.cursor()
        cur.execute(
            "SELECT symbol, iep, total_buy_qty, total_sell_qty, preopen_imbalance, "
            "total_traded_volume FROM preopen_stock_snapshot "
            "WHERE total_traded_volume IS NOT NULL ORDER BY total_traded_volume DESC LIMIT 5"
        )
        rows = cur.fetchall()
        assert rows, (
            "no row carried a non-NULL total_traded_volume -- either NSE stopped populating "
            "totalTradedVolume/finalQuantity, or the parse in fetch_nse_preopen() broke."
        )
        for r in rows:
            sym = r["symbol"]
            assert sym and sym.isupper() and " " not in sym, f"not a real ticker: {sym!r}"
            assert_numeric_and_finite(r["total_traded_volume"], f"{sym}.total_traded_volume")
            assert r["total_traded_volume"] > 0, f"{sym}: traded volume should be positive"
            if r["total_buy_qty"] is not None and r["total_sell_qty"] is not None:
                assert_numeric_and_finite(r["preopen_imbalance"], f"{sym}.preopen_imbalance")
                assert -1.0 <= r["preopen_imbalance"] <= 1.0, (
                    f"{sym}: preopen_imbalance {r['preopen_imbalance']} outside [-1, 1]"
                )

        # technical_signals backfill: the fetcher only updates rows that already exist for
        # today, and this throwaway DB has none, so this asserts the write path doesn't error
        # on zero matches rather than asserting a real backfill happened.
        cur.execute("SELECT count(*) AS n FROM technical_signals")
        assert cur.fetchone()["n"] == 0, "backfill should not have inserted new rows"
