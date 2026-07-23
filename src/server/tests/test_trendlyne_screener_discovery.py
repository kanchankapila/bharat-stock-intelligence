import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from trendlyne_screener_discovery import extract_screener_info


def _kayal_response(headers, rows, title="Test Screener"):
    return {
        "body": {
            "screenObj": {"title": title, "description": "desc", "query": "q"},
            "tableData": rows,
            "tableHeaders": headers,
            "relatedScreeners": [],
        }
    }


class TestSymbolColumnDetection:
    def test_extracts_symbols_when_nsecode_header_present(self):
        data = _kayal_response(
            headers=[{"field": "name"}, {"field": "nsecode"}, {"field": "price"}],
            rows=[["Reliance Industries", "RELIANCE", 2500], ["Infosys", "INFY", 1500]],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == ["RELIANCE", "INFY"]

    def test_extracts_symbols_when_symbol_header_present(self):
        data = _kayal_response(
            headers=[{"field": "symbol"}, {"field": "price"}],
            rows=[["TCS", 3500]],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == ["TCS"]

    def test_extracts_symbols_via_real_kayal_unique_name_shape(self):
        # Regression test for the actual root cause: the live Kayal API's real header
        # shape uses `unique_name` (verified live, 2026-07-23 against screener pk 42221) —
        # NOT `field`/`key`, which this code checked for years without ever matching. Every
        # header on every real screener had field=None/key=None, so the (now-removed) blind
        # "column 0" fallback was firing on 100% of runs, not just an edge case.
        data = _kayal_response(
            headers=[
                {"name": "Current URL", "type": "string", "unique_name": "current_url"},
                {"name": "NSE Symbol", "type": "string", "unique_name": "NSEcode"},
                {"name": "Market Cap", "type": "number", "unique_name": "MCAP_Q"},
            ],
            rows=[
                ["https://trendlyne.com/equity/1234/RELIANCE/RELIANCE-INDUSTRIES-LTD/", "RELIANCE", 1800000],
                ["https://trendlyne.com/equity/5678/INFY/INFOSYS-LTD/", "INFY", 700000],
            ],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == ["RELIANCE", "INFY"]


class TestNoBlindColumnZeroFallback:
    """Regression test for the root cause of ~2M corrupted rows in
    trendlyne_screener_stocks/confluence_signals: when no header matches a known
    symbol field name, the old code blindly used column 0 — which for some
    screeners is a stock-name/profile-link column, not the ticker. Column 0 for
    these screeners contained URLs like
    'https://trendlyne.com/equity/108994/541945/RANJEET-MECHATRONICS-LTD/',
    which got written directly into the `symbol` DB column with zero validation.
    """

    def test_no_recognized_header_skips_extraction_entirely(self):
        # None of these header names match ("stockname", "cmp") — the old code
        # would have picked column 0 (a URL) as the symbol. The fix must return
        # zero stocks rather than guess.
        data = _kayal_response(
            headers=[{"field": "stockname"}, {"field": "cmp"}],
            rows=[["https://trendlyne.com/equity/108994/541945/RANJEET-MECHATRONICS-LTD/", 120]],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == []

    def test_url_shaped_value_in_a_column_is_rejected_even_if_header_matches(self):
        # Defense in depth: even if a column happens to be labeled correctly but
        # contains a URL (bad upstream data), the per-value sanity check must
        # reject it rather than store it.
        data = _kayal_response(
            headers=[{"field": "symbol"}],
            rows=[
                ["https://trendlyne.com/equity/929/NESCO/NESCO-LTD/"],
                ["NESCO"],
            ],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == ["NESCO"]

    def test_overlong_value_is_rejected(self):
        data = _kayal_response(
            headers=[{"field": "symbol"}],
            rows=[["A" * 25], ["RELIANCE"]],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == ["RELIANCE"]

    def test_value_with_spaces_is_rejected(self):
        data = _kayal_response(
            headers=[{"field": "symbol"}],
            rows=[["Ranjeet Mechatronics Ltd"], ["RELIANCE"]],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == ["RELIANCE"]

    def test_hyphenated_and_ampersand_tickers_still_accepted(self):
        # Real NSE tickers can contain '-' (BAJAJ-AUTO) and '&' (M&M) — the
        # sanity regex must not reject these as false positives.
        data = _kayal_response(
            headers=[{"field": "symbol"}],
            rows=[["BAJAJ-AUTO"], ["M&M"]],
        )
        info = extract_screener_info(1, data)
        assert info["stocks"] == ["BAJAJ-AUTO", "M&M"]
