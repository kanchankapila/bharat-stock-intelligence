"""Live-datasource tests for the three NSE filing backfills (data-sources.md mandate):
nse_results_filings_fetcher, nse_pit_fetcher, nse_shareholding_master_fetcher.

Each calls the fetcher's OWN crawl() (its NseClient, URL builder, parser and upsert) against the real
NSE endpoint with a tiny request budget, writes into a throwaway schema (pg_conn), and reads the
rows back. The symbol master comes from scripts/stocklist.json (symbol + ISIN), never hardcoded.
Skipped unless RUN_LIVE_DATASOURCE_TESTS=1.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nse_pit_fetcher as pit  # noqa: E402
import nse_results_filings_fetcher as res  # noqa: E402
import nse_shareholding_master_fetcher as shp  # noqa: E402
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite  # noqa: E402
from nse_filings_common import IST, NseClient, today_ist  # noqa: E402

STOCKLIST = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "stocklist.json")


def _seed_master(conn):
    with open(STOCKLIST, encoding="utf-8-sig") as f:
        entries = [(e["symbol"], e.get("isin") or None) for e in json.load(f) if e.get("symbol")]
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, isin TEXT)")
    conn.executemany("INSERT INTO nse_stocks VALUES (?, ?) ON CONFLICT DO NOTHING", entries)
    conn.commit()
    return dict(entries)


@pytest.mark.live_datasource
class TestNseFilingsLive:
    def test_results_window_writes_sbin_q3fy22_with_broadcast_ts(self, pg_conn):
        master = _seed_master(pg_conn)
        assert master.get("SBIN"), "SBIN must carry an ISIN in scripts/stocklist.json"
        res.ensure_schema(pg_conn)
        client = NseClient(max_requests=4)
        stats = res.crawl(pg_conn, client, date(2022, 2, 1), date(2022, 2, 5), periods=("Quarterly",))
        assert stats["stop"] is None, stats
        assert stats["fetched"] > 100, stats
        rows = pg_conn.execute(
            "SELECT symbol, period_end, consolidated, broadcast_ts FROM nse_results_filings WHERE symbol='SBIN'"
        ).fetchall()
        assert {r[2] for r in rows} == {"Consolidated", "Non-Consolidated"}, rows
        for sym, period_end, _, ts in rows:
            assert_looks_like_ticker(sym, context="nse_results_filings.symbol")
            assert str(period_end)[:10] == "2021-12-31"
            assert datetime(2022, 2, 1, tzinfo=IST) <= ts < datetime(2022, 2, 6, tzinfo=IST)

    def test_pit_window_writes_disseminated_rows(self, pg_conn):
        # corporates-pit returns NOTHING after 2026-05-02 (probed 2026-10-09: 28-Apr..02-May-2026 -> 38
        # rows, 01..05-Jul-2026 and 01..08-Oct-2026 -> empty), so this pins the last populated window.
        # Recent filings moved somewhere this route does not serve; see nse_pit_fetcher's docstring.
        _seed_master(pg_conn)
        pit.ensure_schema(pg_conn)
        end = date(2026, 5, 2)
        client = NseClient(max_requests=3)
        stats = pit.crawl(pg_conn, client, end - timedelta(days=4), end)
        assert stats["stop"] is None, stats
        assert stats["written"] > 0, stats
        rows = pg_conn.execute(
            "SELECT symbol, dissemination_ts, sec_acq FROM nse_pit_disclosures ORDER BY dissemination_ts DESC LIMIT 20"
        ).fetchall()
        for sym, ts, qty in rows:
            assert_looks_like_ticker(sym, context="nse_pit_disclosures.symbol")
            assert ts.astimezone(IST).date() >= end - timedelta(days=4)
            if qty is not None:
                assert_numeric_and_finite(qty, context="nse_pit_disclosures.sec_acq")

    def test_shareholding_master_tcs_has_five_years(self, pg_conn):
        shp.ensure_schema(pg_conn)
        client = NseClient(max_requests=3)
        stats = shp.crawl(pg_conn, client, ["TCS"])
        assert stats["stop"] is None and stats["written"] >= 16, stats
        rows = pg_conn.execute(
            "SELECT quarter_end, promoter_pct, public_pct, broadcast_ts FROM nse_shareholding_history "
            "WHERE symbol='TCS' ORDER BY quarter_end DESC").fetchall()
        assert date.fromisoformat(str(rows[0][0])[:10]) >= today_ist() - timedelta(days=200)
        for q, prom, pub, ts in rows:
            assert_numeric_and_finite(prom, context="promoter_pct")
            assert_numeric_and_finite(pub, context="public_pct")
            assert ts.astimezone(IST).date() > date.fromisoformat(str(q)[:10])

    def test_integrated_filing_window_pages_and_writes(self, pg_conn):
        # Successor route for results from 2025-04 (legacy route empty after ~2025-02-13).
        _seed_master(pg_conn)
        res.ensure_schema(pg_conn)
        client = NseClient(max_requests=6)
        stats = res.crawl_integrated(pg_conn, client, date(2025, 8, 10), date(2025, 8, 14), page_size=500)
        assert stats["stop"] is None, stats
        assert stats["fetched"] > 1000, stats  # 1,442 on 2026-10-10 -> 3 pages of 500
        rows = pg_conn.execute(
            "SELECT symbol, period, period_end, broadcast_ts FROM nse_results_filings LIMIT 50").fetchall()
        assert rows
        for sym, period, period_end, ts in rows:
            assert_looks_like_ticker(sym, context="nse_results_filings.symbol")
            assert period == res.INTEGRATED_PERIOD and str(period_end)[:10] == "2025-06-30"
            assert datetime(2025, 8, 10, tzinfo=IST) <= ts < datetime(2025, 8, 15, tzinfo=IST)
