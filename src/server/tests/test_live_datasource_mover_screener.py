"""Live-datasource test for mover_screener_fetcher.py (MANDATORY per data-sources.md).

mover_screener_fetcher.py aggregates several genuinely distinct provider integrations into
one module (ET TechnicalScreeners, MarketsMojo, NiftyTrader EOD screener, NiftyTrader top
gainers, MoneyControl price shockers) writing one shared table, mover_snapshots. A single
"hit one endpoint" test would leave four of the five silently unverified, so this file has
one class per LIVE provider surface rather than one test for the module as a whole -- each
hits the real endpoint, parses with the fetcher's OWN function, and writes through the
fetcher's OWN persist() into a throwaway schema.

Deliberately NOT covered here:
  - fetch_et() (the classic /ET_Stats/gainers listing) -- documented in the fetcher's own
    header as down server-side since 2026-08-25 (503 upstream, not a client bug). A live test
    against a known-dead endpoint would be permanently red for a reason unrelated to our code;
    fetch_et_screens() below is the verified-live replacement covering the same ET surface.
  - fetch_nt_live_screener() -- Prime-token-gated (needs a JWT from app_settings that a test
    environment does not have) and already best-effort by design in production (skipped
    silently when the token is absent). Nothing to verify without a live Prime account.

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI -- a transient
upstream outage on any one of these providers must not fail the build.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))  # live_datasource_helpers lives here
from pg_test_support import pg_memory_conn  # noqa: E402

from live_datasource_helpers import (  # noqa: E402
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_numeric_and_finite,
)

pytestmark = pytest.mark.live_datasource

from curl_cffi import requests as cffi_requests  # noqa: E402

import mover_screener_fetcher as msf  # noqa: E402


class FakeConn:
    """Throwaway in-memory DB so the test never touches production."""

    def __init__(self):
        self._c = pg_memory_conn()

    def execute(self, sql, params=()):
        return self._c.execute(sql, params)

    def cursor(self):
        return self._c.cursor()

    def commit(self):
        self._c.commit()

    def close(self):
        self._c.close()


def _session():
    return cffi_requests.Session(impersonate="chrome")


def _write_and_read_back(rows, source_prefix):
    """Persist real rows through the fetcher's own persist(), read one back, and
    assert it's ML-usable -- catches both parsing bugs and storage/type-coercion bugs."""
    conn = FakeConn()
    try:
        msf.ensure_schema(conn)
        n = msf.persist(conn, rows, "2026-08-27T09:00:00")
        assert n == len(rows)
        cur = conn.cursor()
        cur.execute(
            "SELECT symbol, rank, pct_change, metric_value FROM mover_snapshots "
            "WHERE source = ? ORDER BY symbol",
            (source_prefix,),
        )
        stored = cur.fetchall()
        assert len(stored) > 0, f"no rows stored for source {source_prefix!r}"
        for row in stored[:20]:
            symbol, rank, pct_change, metric_value = row
            assert_looks_like_ticker(symbol, f"{source_prefix}.symbol")
            if rank is not None:
                assert_numeric_and_finite(rank, f"{source_prefix}.rank")
            if pct_change is not None:
                assert_numeric_and_finite(pct_change, f"{source_prefix}.pct_change")
            if metric_value is not None:
                assert_numeric_and_finite(metric_value, f"{source_prefix}.metric_value")
    finally:
        conn.close()


class TestNiftyTraderTopGainersLive:
    """api.niftytrader.in/webapi/symbol/top-gainers-data -- unauthenticated, no crosswalk."""

    def test_real_fetch_returns_real_tickers(self):
        rows = msf.fetch_niftytrader(_session())
        assert_non_empty_response(rows, "fetch_niftytrader")
        for source, symbol, rank, pct, metric, payload in rows[:20]:
            assert source == "nt_top_gainers"
            assert_looks_like_ticker(symbol, "nt_top_gainers.symbol")
            assert_numeric_and_finite(rank, "nt_top_gainers.rank")

    def test_real_rows_store_ml_usable(self):
        rows = msf.fetch_niftytrader(_session())
        assert_non_empty_response(rows, "fetch_niftytrader")
        tagged = [r + ("2026-08-27",) for r in rows]
        _write_and_read_back(tagged, "nt_top_gainers")


class TestNiftyTraderEodScreenerLive:
    """www.niftytrader.in/api/niftytrader/Screener/advance-eod-screener-filter, reverse-engineered
    2026-08-25. Tests one representative screen (gap-up) rather than all ten -- they share
    one endpoint and one parser (_rows_from_nt_screener), so one real request exercises the
    whole family's parsing path; test_mover_screener_fetcher.py's fake-session unit tests
    already cover that every catalog entry maps through the same code correctly."""

    def test_real_fetch_returns_real_tickers(self):
        rows = msf.fetch_nt_screens(_session(), {"nteod_gap_up"})
        assert_non_empty_response(rows, "fetch_nt_screens(nteod_gap_up)")
        for source, symbol, rank, pct, metric, payload in rows[:20]:
            assert source == "nteod_gap_up"
            assert_looks_like_ticker(symbol, "nteod_gap_up.symbol")

    def test_real_rows_store_ml_usable(self):
        rows = msf.fetch_nt_screens(_session(), {"nteod_gap_up"})
        assert_non_empty_response(rows, "fetch_nt_screens(nteod_gap_up)")
        tagged = [r + ("2026-08-27",) for r in rows]
        _write_and_read_back(tagged, "nteod_gap_up")


class TestMarketsMojoMoversLive:
    """frapi.marketsmojo.com/market_Gainersloser -- sid-keyed, resolved via stocklist.json."""

    def test_real_fetch_resolves_sids_to_real_tickers(self):
        rows = msf.fetch_mojo(_session())
        assert_non_empty_response(rows, "fetch_mojo")
        gainers = [r for r in rows if r[0] == "mojo_gainers"]
        assert_non_empty_response(gainers, "fetch_mojo (mojo_gainers)")
        for source, symbol, rank, pct, metric, payload in gainers[:20]:
            assert_looks_like_ticker(symbol, "mojo_gainers.symbol")

    def test_real_rows_store_ml_usable(self):
        rows = msf.fetch_mojo(_session())
        gainers = [r for r in rows if r[0] == "mojo_gainers"]
        assert_non_empty_response(gainers, "fetch_mojo (mojo_gainers)")
        tagged = [r + ("2026-08-27",) for r in gainers]
        _write_and_read_back(tagged, "mojo_gainers")


class TestEtTechnicalScreenersLive:
    """etmarketsapis.indiatimes.com/ET_TechnicalScreeners -- the replacement ET surface
    (classic /ET_Stats/gainers is down upstream, see this file's own header). companyId ->
    NSE symbol resolved via scripts/stocklist.json inside fetch_et_screens itself."""

    def test_real_fetch_returns_real_tickers(self):
        rows = msf.fetch_et_screens(_session(), {"et_screen_long_white_candle"})
        assert_non_empty_response(rows, "fetch_et_screens(long_white_candle)")
        for source, symbol, rank, pct, metric, payload in rows[:20]:
            assert source == "et_screen_long_white_candle"
            assert_looks_like_ticker(symbol, "et_screen_long_white_candle.symbol")

    def test_real_rows_store_ml_usable(self):
        rows = msf.fetch_et_screens(_session(), {"et_screen_long_white_candle"})
        assert_non_empty_response(rows, "fetch_et_screens(long_white_candle)")
        tagged = [r + ("2026-08-27",) for r in rows]
        _write_and_read_back(tagged, "et_screen_long_white_candle")


class TestMoneyControlPriceShockersLive:
    """api.moneycontrol.com/mcapi/v1/earnings/price-shockers -- scID mapped via
    nse_stocks.mcsymbol, so this also exercises the live DB-backed symbol crosswalk."""

    def test_real_fetch_maps_scid_to_real_tickers(self):
        rows = msf.fetch_mc_shockers(_session(), symbol_map=msf._mc_symbol_map())
        assert_non_empty_response(rows, "fetch_mc_shockers")
        for source, symbol, rank, pct, metric, payload in rows[:20]:
            assert source == "mc_price_shockers"
            assert_looks_like_ticker(symbol, "mc_price_shockers.symbol")

    def test_real_rows_store_ml_usable(self):
        rows = msf.fetch_mc_shockers(_session(), symbol_map=msf._mc_symbol_map())
        assert_non_empty_response(rows, "fetch_mc_shockers")
        tagged = [r + ("2026-08-27",) for r in rows]
        _write_and_read_back(tagged, "mc_price_shockers")
