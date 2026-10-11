"""Live-datasource test for nse_xbrl_fundamentals_fetcher (data-sources.md mandate).

End to end through the fetchers' OWN code: nse_results_filings_fetcher.crawl_integrated lists one real
results day into a throwaway schema (pg_conn), then select_filings/crawl/parse_xbrl fetch and parse
INFY's consolidated Q1-FY27 XBRL from nsearchives and the row is read back. The XBRL link comes from
NSE's own listing, never hardcoded. Skipped unless RUN_LIVE_DATASOURCE_TESTS=1.
"""
import json
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nse_results_filings_fetcher as res  # noqa: E402
import nse_xbrl_fundamentals_fetcher as xf  # noqa: E402
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite  # noqa: E402
from nse_filings_common import NseClient  # noqa: E402

STOCKLIST = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "stocklist.json")
DAY = date(2026, 7, 23)  # INFY announced Q1-FY27 that evening


@pytest.mark.live_datasource
def test_infy_q1fy27_xbrl_parses_into_rupee_crore(pg_conn):
    with open(STOCKLIST, encoding="utf-8-sig") as f:
        entries = [(e["symbol"], e.get("isin") or None) for e in json.load(f) if e.get("symbol")]
    pg_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, isin TEXT)")
    pg_conn.executemany("INSERT INTO nse_stocks VALUES (?, ?) ON CONFLICT DO NOTHING", entries)
    pg_conn.commit()
    res.ensure_schema(pg_conn)
    xf.ensure_schema(pg_conn)

    client = NseClient(max_requests=8)
    listed = res.crawl_integrated(pg_conn, client, DAY, DAY, page_size=2000)
    assert listed["stop"] is None and listed["written"] > 50, listed

    sel = [f for f in xf.select_filings(pg_conn, DAY, DAY, only_latest=True) if f["symbol"] == "INFY"]
    assert len(sel) == 1 and sel[0]["consolidated"] == "Consolidated", sel
    stats = xf.crawl(pg_conn, client, sel)
    assert stats["stop"] is None and stats["parsed"] == 1, stats

    row = pg_conn.execute(
        "SELECT symbol, period_end, period_start, revenue, pat, pbt, eps_basic, parse_error "
        "FROM nse_filing_financials").fetchone()
    sym, period_end, period_start, revenue, pat, pbt, eps, err = row
    assert_looks_like_ticker(sym, context="nse_filing_financials.symbol")
    assert err is None
    assert str(period_end)[:10] == "2026-06-30" and str(period_start)[:10] == "2026-04-01"
    for name, v in (("revenue", revenue), ("pat", pat), ("pbt", pbt), ("eps_basic", eps)):
        assert_numeric_and_finite(v, context=f"nse_filing_financials.{name}")
    # Rs crore, not rupees or lakhs: INFY's quarterly revenue is tens of thousands of crore.
    assert 30_000 < float(revenue) < 100_000 and 0 < float(pat) < float(revenue)
