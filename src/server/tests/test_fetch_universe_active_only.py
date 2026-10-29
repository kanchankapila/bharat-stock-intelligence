"""Fetch universes and provider-id maps read only ACTIVE nse_stocks rows.

nse_stocks keeps 42 INACTIVE/DELISTED aliases (KOTAK, INDUSIND, LARSEN, NESTLE...) that share an
mcsymbol or ISIN with the live listing. Measured 2026-10-29: 528 stock_futures_oi_history and
1,026 analyst_estimates_history rows were written under alias symbols, and the ISIN map in
credit_rating_fetcher keeps whichever duplicate-ISIN row came last (e.g. INE470A01017 is both
3MINDIA and the phantom CHOLAFINSV).
"""
import inspect

import pytest

import analyst_estimates_snapshot
import credit_rating_fetcher
import mc_stock_futures_oi_fetcher
import screener_ohlcv_backfill

READERS = [
    ("analyst_estimates_snapshot._SELECT_SYMBOLS", analyst_estimates_snapshot._SELECT_SYMBOLS),
    ("mc_stock_futures_oi_fetcher.load_mc_symbol_map", inspect.getsource(mc_stock_futures_oi_fetcher.load_mc_symbol_map)),
    ("credit_rating_fetcher ISIN map", inspect.getsource(credit_rating_fetcher)),
    ("screener_ohlcv_backfill.get_missing_symbols", inspect.getsource(screener_ohlcv_backfill.get_missing_symbols)),
]


@pytest.mark.parametrize("name,src", READERS, ids=[r[0] for r in READERS])
def test_reads_only_active_listings(name, src):
    assert "status = 'ACTIVE'" in src, f"{name} reads retired aliases from nse_stocks"
