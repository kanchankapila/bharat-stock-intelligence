"""Live-datasource test for so_option_chain_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). The only source in the platform providing per-strike options
GREEKS for individual stocks (Trendlyne SmartOptions -- distinct provider/table from
stock_option_chain_fetcher.py's NiftyTrader-sourced expected-move/GEX-proxy).

Per the endpoint-corpus review's documented gotcha (CLAUDE.md 2026-07-31): an expired
`expDate` returns 200 with real strike/OI data but NULL implied_volatility and every Greek
exactly 0.0 -- passes a naive non-empty/non-null check. This test uses the fetcher's own
_get_nearest_expiry() (never a hardcoded date) and explicitly asserts a real Greek is
non-zero, not just non-null, to catch that exact trap.

execute()/executemany()/query_all() are bare module-level functions imported from
db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as the nt_*
fetchers.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import so_option_chain_fetcher as soc
from live_datasource_helpers import assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


def _resolve_real_expiry(symbol: str) -> str:
    """Prefer the real nt_fno_expiry table (production Postgres) -- individual STOCK
    options (unlike NIFTY/BANKNIFTY) only have MONTHLY expiries, so _nearest_thursday()'s
    fallback can pick an invalid weekly date most of the month and get back a real 200
    response with zero strikes (confirmed live) rather than a fetch failure. Falls back to
    the fetcher's own _nearest_thursday() only if no DB is reachable at all."""
    try:
        import psycopg2
        conn = psycopg2.connect(host="127.0.0.1", port=5433, user="bharat",
                                 password="bharat", dbname="bharat_intel", connect_timeout=3)
        cur = conn.cursor()
        cur.execute(
            "SELECT expiry FROM nt_fno_expiry WHERE symbol = %s AND exchange = 'NSE' "
            "AND expiry >= %s ORDER BY expiry LIMIT 1",
            (symbol, soc._date.today().isoformat()),
        )
        row = cur.fetchone()
        conn.close()
        if row:
            return str(row[0])[:10]
    except Exception:
        pass
    return soc._nearest_thursday()


class _CaptureDB:
    def __init__(self):
        self.executemany_calls = []
        self.execute_calls = []

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)

    def execute(self, sql, params=None):
        self.execute_calls.append((sql, params))

    def query_all(self, sql, params=None):
        return []  # no nt_fno_expiry/nse_stocks rows in this throwaway context


@pytest.mark.live_datasource
class TestSoOptionChainFetcherLiveDataSource:
    def test_real_fetch_and_parse_with_own_expiry_resolution(self):
        """Hits the real SmartOptions chain endpoint for RELIANCE, resolved against the real
        nt_fno_expiry table the same way _get_nearest_expiry() does in production (never a
        hardcoded stale date -- see _resolve_real_expiry() above for why the fetcher's own
        _nearest_thursday() fallback isn't safe to force here: individual stock options only
        have monthly expiries, so a forced weekly-Thursday fallback can itself return a real
        200 with zero strikes most of the month)."""
        expiry = _resolve_real_expiry(REAL_SYMBOL)
        assert expiry, "could not resolve a real nearest expiry for RELIANCE"

        body = soc.fetch_chain(REAL_SYMBOL, expiry)
        assert body is not None, f"fetch_chain() returned None for RELIANCE/{expiry} -- endpoint may be down or that expiry has passed"

        chain_rows, summary = soc._parse_chain(body, REAL_SYMBOL, "2026-01-01", expiry)
        assert chain_rows, "_parse_chain() produced zero strike rows from a real non-empty response"

        sample = chain_rows[0]
        # column order per save_chain(): (symbol, date, expiry, strike, ce_price, ce_volume,
        # ce_oi, ce_oi_chg, ce_iv, ce_iv_chg, ce_delta, ce_gamma, ce_theta, ce_vega, ce_rho, ...)
        strike = sample[3]
        assert_numeric_and_finite(strike, context="strike")

        # At least one strike in a real, liquid chain must have a genuinely non-zero Greek --
        # catches the documented expired-expiry trap (real OI, all-zero Greeks) directly.
        deltas = [row[10] for row in chain_rows if row[10] is not None]
        assert deltas, "no ce_delta values parsed at all"
        assert any(d != 0.0 for d in deltas), \
            "every parsed ce_delta is exactly 0.0 across the whole chain -- looks like the expired-expiry zero-Greeks trap"

        assert summary is not None, "_parse_chain() returned no summary dict"
        assert summary["symbol"] == REAL_SYMBOL

    def test_save_chain_writes_ml_usable_rows(self):
        """Writes real parsed chain rows through the fetcher's own save_chain(), with
        execute()/executemany() monkeypatched to a capture object instead of the real DB."""
        expiry = _resolve_real_expiry(REAL_SYMBOL)
        body = soc.fetch_chain(REAL_SYMBOL, expiry)
        assert body is not None, "no real chain to exercise the write path with"
        chain_rows, summary = soc._parse_chain(body, REAL_SYMBOL, "2026-01-01", expiry)
        assert chain_rows, "no real chain rows to exercise the write path with"

        cap = _CaptureDB()
        orig_execute, orig_executemany = soc.execute, soc.executemany
        soc.execute, soc.executemany = cap.execute, cap.executemany
        try:
            n = soc.save_chain(chain_rows, summary)
        finally:
            soc.execute, soc.executemany = orig_execute, orig_executemany

        assert n == len(chain_rows)
        assert cap.executemany_calls, "save_chain() made no executemany() calls despite real chain rows"
        chain_calls = [(sql, r) for sql, r in cap.executemany_calls if "so_option_chain" in sql]
        assert chain_calls, "save_chain() never wrote to so_option_chain"
        for sql, row in chain_calls[:5]:
            symbol, date, exp, strike = row[0], row[1], row[2], row[3]
            assert symbol == REAL_SYMBOL
            assert_numeric_and_finite(strike, context="so_option_chain.strike")

        if summary:
            summary_calls = [(sql, p) for sql, p in cap.execute_calls if "so_stock_oi_summary" in sql]
            assert summary_calls, "save_chain() had a summary but never wrote to so_stock_oi_summary"
