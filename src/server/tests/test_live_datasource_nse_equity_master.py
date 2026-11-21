"""Opt-in live contract test for NSE's official equity and ETF master catalogues."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from live_datasource_helpers import assert_looks_like_ticker
import nse_equity_master_fetcher as master

pytestmark = pytest.mark.live_datasource


def test_live_official_masters_are_complete_disjoint_and_current():
    equities, etfs = master.fetch_official_masters()
    equity_symbols = {row["symbol"] for row in equities}
    etf_symbols = {row["symbol"] for row in etfs}
    assert len(equities) >= master.MIN_EQUITY_ROWS
    assert len(etfs) >= master.MIN_ETF_ROWS
    assert not equity_symbols & etf_symbols
    for symbol in list(equity_symbols)[:300] + list(etf_symbols)[:100]:
        assert_looks_like_ticker(symbol)
    assert {"RELIANCE", "HDFCBANK", "INFY"} <= equity_symbols
    assert "NIFTYBEES" in etf_symbols



def test_live_symbol_change_archive_follows_a_known_rename():
    # AF-20261120-07: admission carries a renamed company's sessions. ICICIPRULI -> ICICILIFE took
    # effect 2026-10-23 and stays inside the 400-day lookback until late 2027.
    predecessors = master.fetch_predecessors()
    assert len(predecessors) >= 20, "symbol-change archive unreadable or schema moved"
    for current, olds in predecessors.items():
        assert_looks_like_ticker(current)
        assert olds and all(o != current for o in olds)
    assert "ICICIPRULI" in predecessors.get("ICICILIFE", [])
