"""Live-datasource tests for the highest-blast-radius `technical_signals` fetchers.

CLAUDE.md's "Adding a New Data Source" rule makes one of these mandatory per fetcher. Coverage
was 17 of ~140 DB-writing Python files; the 2026-07-30 fifth-pass audit called it the single
largest open control gap, and the 2026-07-31 endpoint-corpus audit re-confirmed it.

Rather than chase all ~125, this batch targets by BLAST RADIUS: every fetcher here writes
directly into `technical_signals`, the ML feature matrix that `ml_ensemble.py` trains on. A
silent break in any of them degrades the model with nothing erroring — exactly the failure that
went undetected for a fetcher's entire life in the 2026-07-23 URL-as-symbol incident.

Grouped in one file following the existing precedent of
test_live_datasource_extra_endpoints.py / _round3_endpoints.py.

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI — these hit real
third-party endpoints, and a transient upstream outage must never fail a build.
"""
import datetime
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from live_datasource_helpers import (
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_numeric_and_finite,
)


@pytest.mark.live_datasource
class TestDeliveryVolumeFetcher:
    """NSE MTO archive -> delivery_pct / delivery_trend_30d, both flagged at 0% coverage by
    the endpoint-corpus audit. A wiring gap there, not a data gap — so the feed must work."""

    def test_real_mto_file_parses_into_ml_usable_rows(self):
        import delivery_volume_fetcher as dvf

        session = requests.Session()
        session.headers.update(dvf.HEADERS)

        # Walk back over recent sessions: the most recent day may be a holiday or not yet
        # published, and a 404 there is correct behaviour rather than a failure.
        rows = None
        for d in dvf._trading_days_back(6):
            rows = dvf.fetch_mto(d, session)
            if rows:
                break
        if rows is None:
            pytest.skip("NSE MTO archive unreachable from this host")
        assert_non_empty_response(rows, "delivery_volume_fetcher.fetch_mto()")

        sample = rows[:20]
        for r in sample:
            assert_looks_like_ticker(r["symbol"], "MTO symbol")
            assert_numeric_and_finite(r["deliverable_qty"], "deliverable_qty")
            assert_numeric_and_finite(r["qty_traded"], "qty_traded")
            assert_numeric_and_finite(r["delivery_pct"], "delivery_pct")
            assert 0 <= r["delivery_pct"] <= 100, (
                f"{r['symbol']}: delivery {r['delivery_pct']}% is not a percentage"
            )
            # Delivered shares can never exceed shares traded; if they do, the two columns
            # have been swapped or mis-parsed from the fixed-width MTO file.
            assert r["deliverable_qty"] <= r["qty_traded"], (
                f"{r['symbol']}: delivered {r['deliverable_qty']} > traded {r['qty_traded']}"
            )


@pytest.mark.live_datasource
class TestNiftyTraderDashboard:
    """NiftyTrader options dashboard -> PCR / OI / VIX features on technical_signals."""

    def test_real_dashboard_parses_into_ml_usable_rows(self):
        import nt_dashboard_fetcher as ntd

        payload = ntd._fetch_all()
        if payload is None:
            pytest.skip("NiftyTrader dashboard unreachable from this host")

        # Real shape, verified live: {"indices": [...], "stocks": [...]}.
        assert isinstance(payload, dict) and "stocks" in payload, (
            f"NiftyTrader changed its response shape: {list(payload)[:6]}"
        )
        records = payload["stocks"]
        assert_non_empty_response(records, "nt_dashboard_fetcher._fetch_all()['stocks']")

        today = datetime.date.today().isoformat()
        parsed = [p for p in (ntd._parse_record(r, today)
                              for r in records if isinstance(r, dict)) if p]
        assert_non_empty_response(parsed, "nt_dashboard_fetcher._parse_record()")

        f = parsed[0]
        assert_looks_like_ticker(str(f.get("symbol")), "nt dashboard symbol")
        # At least one real number must survive parsing — a row of all-None would pass a
        # bare non-empty check while carrying nothing usable.
        numeric = [v for k, v in f.items()
                   if k not in ("symbol", "date") and isinstance(v, (int, float))]
        assert numeric, f"no numeric fields survived parsing: {f}"
        for v in numeric:
            assert_numeric_and_finite(v, "nt dashboard numeric field")


@pytest.mark.live_datasource
class TestPreopenFetcher:
    """MoneyControl premarket -> preopen snapshot. Runs in a 5-minute window before the open,
    so a silent break here is invisible for most of the day."""

    def test_real_sections_return_parseable_market_data(self):
        import preopen_fetcher as pf

        items = pf.fetch_section(pf.MI_URL)
        assert_non_empty_response(items, "preopen_fetcher.fetch_section(MI_URL)")
        assert any(isinstance(i, dict) for i in items), f"unexpected shape: {items[:2]}"

        # The fetcher locates entries by name fragment; if MC renames them the fetcher goes
        # quietly blank, so assert its OWN finder still resolves something.
        found = pf._find(items, "nifty")
        assert found is not None, (
            "preopen_fetcher._find() no longer matches a Nifty entry — MoneyControl may have "
            f"renamed its sections. Available: {[i.get('name') for i in items[:10]]}"
        )


@pytest.mark.live_datasource
class TestMcTechScanner:
    """MoneyControl techscanner -> bullish/breakout membership flags on technical_signals.

    These are SET-membership features, so the silent-failure mode is specific: an empty set is
    indistinguishable from 'no stock qualified today' unless you check the endpoint itself.
    """

    def test_real_scan_returns_mc_symbols(self):
        import mc_techscanner_fetcher as mcs

        session = requests.Session()
        session.headers.update(mcs.HEADERS)

        got = set()
        for cat_id, scan_id in mcs.BULLISH_SCANS[:3]:
            got |= mcs._fetch_scan(session, cat_id, scan_id)
            if got:
                break
        assert got, (
            "every sampled bullish scan returned an empty set — either MC changed the "
            "endpoint/response shape, or the scans genuinely matched nothing (check by hand)"
        )
        # These are MC's opaque short codes (RI, SBI, HDF01), NOT NSE tickers, so
        # assert_looks_like_ticker would be the wrong check here. What matters is that they
        # are short opaque codes rather than a URL or scrape artifact.
        for code in list(got)[:10]:
            assert isinstance(code, str) and 1 <= len(code) <= 12, f"bad mcsymbol: {code!r}"
            assert "://" not in code and " " not in code, f"scrape artifact: {code!r}"


@pytest.mark.live_datasource
class TestTrendlyneFundamentals:
    """Trendlyne chart-data -> EPS/DVM features. The DVM scores feed several ML columns, and
    factor_edge.py already measured Trendlyne momentum as having NO forward edge — so knowing
    this pipe is alive matters for interpreting that verdict rather than assuming a break."""

    def test_real_fetch_for_a_known_stock(self):
        import trendlyne_fundamentals_fetcher as tlf

        session = requests.Session()
        if hasattr(tlf, "HEADERS"):
            session.headers.update(tlf.HEADERS)

        # HDFCBANK's Trendlyne id, resolved the same way the fetcher's own run() does rather
        # than hardcoded, so a stale mapping fails loudly instead of silently testing nothing.
        from db_compat import connect
        conn = connect()
        row = conn.execute(
            "SELECT tlid FROM nse_stocks WHERE symbol = ? AND tlid IS NOT NULL", ("HDFCBANK",)
        ).fetchone()
        if not row or not row[0]:
            pytest.skip("no tlid mapping for HDFCBANK in nse_stocks")
        tlid = str(row[0])

        body = tlf._fetch(tlid, "EPS_TTM", session)
        if body is None:
            pytest.skip("Trendlyne unreachable from this host")

        series = tlf._parse_eod(body)
        assert_non_empty_response(series, "trendlyne_fundamentals_fetcher._parse_eod()")
        last_date, last_val = series[-1]
        assert len(last_date) == 10 and last_date[4] == "-", f"date not ISO: {last_date}"
        assert_numeric_and_finite(last_val, "EPS_TTM")
