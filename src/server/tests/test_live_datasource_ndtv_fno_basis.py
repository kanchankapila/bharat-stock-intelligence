"""Live-datasource test for ndtv_fno_basis_fetcher.py (CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

Beyond the standard fetch -> own parser -> own writer -> ML-usability round trip, this pins the
finding that resolved a real contradiction in this codebase's own history: a 2026-07-30 pass
judged www.ndtvprofit.com dead (plain `requests`), a 2026-08-03 pass got real data (curl_cffi
TLS impersonation). This test asserts the impersonation requirement directly so a future
"simplify to plain requests" edit fails loudly instead of silently reintroducing the dead path.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import ndtv_fno_basis_fetcher as nfb
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite, assert_non_empty_response


@pytest.mark.live_datasource
class TestNdtvFnoBasisLiveDataSource:
    def test_real_fetch_returns_basis_data_for_a_liquid_fno_stock(self):
        session = nfb._get_session()
        payload = nfb.fetch_one(session, "RELIANCE")
        assert payload is not None, "expected a real 200 response for RELIANCE"
        data = payload.get("data") or {}
        assert data.get("symbol") == "RELIANCE"
        assert data.get("spot-price"), "expected a real spot price"
        assert payload.get("broadcasted-at"), "expected a real broadcast timestamp"

    def test_plain_requests_without_tls_impersonation_does_not_work(self):
        """Pins the finding that resolved the 2026-07-30-vs-2026-08-03 contradiction: this
        host requires curl_cffi's TLS-fingerprint impersonation. If this ever starts passing,
        the endpoint's bot-protection changed and fetch_one() no longer needs impersonate=."""
        import requests as plain_requests
        try:
            r = plain_requests.get(nfb.API, params={"symbol": "RELIANCE"},
                                    headers=nfb.HEADERS, timeout=15)
            got_real_data = False
            if r.status_code == 200:
                try:
                    j = r.json()
                    got_real_data = (j.get("data") or {}).get("symbol") == "RELIANCE"
                except Exception:
                    got_real_data = False
        except Exception:
            got_real_data = False
        assert not got_real_data, (
            "plain requests now works for ndtvprofit.com -- curl_cffi impersonation may no "
            "longer be required; re-verify before simplifying fetch_one()"
        )

    def test_full_fno_universe_fetch_has_high_success_rate(self):
        """Live-verified 2026-08-07: 209/209 HTTP 200, 207/209 real data at 12 concurrent
        workers, 7.0s total. A real regression (rate-limiting kicking in, endpoint change)
        would show up as a coverage drop here -- sampled to 20 symbols to keep this test fast."""
        symbols = nfb.load_fno_symbols()
        assert_non_empty_response(symbols, "load_fno_symbols()")
        sample = symbols[:20]
        ok = 0
        for s in sample:
            payload = nfb.fetch_one(nfb._get_session(), s)
            row = nfb.parse_summary(s, payload) if payload else None
            if row is not None:
                ok += 1
        assert ok / len(sample) >= 0.8, f"only {ok}/{len(sample)} symbols returned usable data"

    def test_stored_rows_are_ml_usable(self):
        payload = nfb.fetch_one(nfb._get_session(), "RELIANCE")
        assert payload is not None
        row = nfb.parse_summary("RELIANCE", payload)
        assert row is not None
        row["date"] = "2026-08-07"

        import sqlite3
        con = pg_memory_conn()
        nfb.ensure_schema(con)
        assert nfb.store(con, [row]) == 1

        symbol, basis, spot = con.execute(
            "SELECT symbol, basis, spot_price FROM ndtv_fno_basis LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        assert_numeric_and_finite(basis, "basis")
        assert_numeric_and_finite(spot, "spot_price")
