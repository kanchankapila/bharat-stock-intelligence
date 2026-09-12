"""AF-20260912-01 negative control.

finstack wraps yfinance. A BARE NSE symbol does not identify the NSE listing on Yahoo --
it resolves to whatever US-listed company owns that ticker. Live-probed 2026-09-12:
IEX -> IDEX Corporation, CUB -> Lionheart Holdings, HAL -> Halliburton. The fetcher sent
the bare symbol, so 13 foreign companies' cash-flow statements were stored under NSE
tickers and ~2,000 other names 404'd.

Revert `yahoo_ticker()` to `return symbol` and test_fetch_symbol_queries_ns_ticker fails.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import finstack_cashflow_fetcher as fcf  # noqa: E402


def test_yahoo_ticker_appends_ns():
    assert fcf.yahoo_ticker("IEX") == "IEX.NS"
    assert fcf.yahoo_ticker("HAL") == "HAL.NS"


class _RecordingMcp:
    """Records the args the fetcher actually sends, and answers with an empty envelope."""

    def __init__(self):
        self.calls = []

    def call_tool(self, tool, args):
        self.calls.append((tool, args))
        return '{"currency": "INR", "data": []}'


def test_fetch_symbol_queries_ns_ticker():
    """The bug was in the ARGUMENT, not the parsing -- assert on what goes out."""
    mcp = _RecordingMcp()
    fcf.fetch_symbol(mcp, "CUB")
    assert len(mcp.calls) == 1
    tool, args = mcp.calls[0]
    assert tool == "cash_flow"
    assert args["symbol"] == "CUB.NS", (
        f"queried {args['symbol']!r}; a bare NSE symbol resolves to a US-listed company "
        f"on Yahoo (CUB -> Lionheart Holdings), not City Union Bank"
    )
    assert args["quarterly"] is True


def test_rows_are_stored_under_the_plain_nse_symbol():
    """The NSE symbol stays canonical: `.NS` is a query detail, never a stored identifier."""
    rows = fcf.parse_quarterly_cashflow(
        {"currency": "INR", "data": [{"period": "2026-06-30", "operating_cash_flow": 1.0}]}
    )
    assert rows and rows[0]["period_end"] == "2026-06-30"
    assert not any(".NS" in str(v) for r in rows for v in r.values())
