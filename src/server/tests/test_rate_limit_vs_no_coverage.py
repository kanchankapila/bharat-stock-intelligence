"""AF-20260910-06 / -07.

A throttled vendor run must never be indistinguishable from "the vendor has no data".

Live on 2026-09-10 the finstack cash-flow fetcher logged hundreds of
"Too Many Requests. Rate limited. Try after a while." errors from Yahoo (via finstack) while
counting every one of them as "no vendor coverage", then exited 0. `finstack_cashflow_history`
holds 59 rows / 15 symbols for a ~2,000-symbol weekly job, and how much of that gap is true
coverage vs. accumulated throttling was never knowable from the code's own output.

Same class as insider_transactions_fetcher's `None`-on-failure vs `[]`-on-genuinely-empty fix.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import pytest

import finstack_cashflow_fetcher as fcf
import mf_holdings_fetcher as mf


class TestRateLimitClassification:
    def test_the_exact_live_message_is_classified_as_throttling(self):
        # Verbatim from the 2026-09-10 07:14 pm2 log.
        env = {"error": True,
               "message": "Too Many Requests. Rate limited. Try after a while."}
        assert fcf.is_rate_limited_envelope(env) is True

    def test_genuine_no_coverage_is_NOT_classified_as_throttling(self):
        # THE control that matters. If this ever returns True, the fix has inverted the bug:
        # real "vendor has no data" symbols would be reported as throttled, the run would
        # abort, and coverage would silently collapse.
        for msg in ("No cash flow data available",
                    "Symbol not found",
                    "no quarterly cashflow for this ticker"):
            assert fcf.is_rate_limited_envelope({"error": True, "message": msg}) is False

    def test_success_envelope_is_never_throttling(self):
        assert fcf.is_rate_limited_envelope({"data": [{"period": "2026-06-30"}]}) is False
        assert fcf.is_rate_limited_envelope(None) is False
        assert fcf.is_rate_limited_envelope("garbage") is False

    def test_parser_contract_is_unchanged_for_both_error_kinds(self):
        # parse_quarterly_cashflow stays pure and still flattens BOTH to [] — the classification
        # is deliberately made before parsing, not by changing the parser's contract.
        throttled = {"error": True, "message": "Too Many Requests. Rate limited."}
        no_cover = {"error": True, "message": "No cash flow data available"}
        assert fcf.parse_quarterly_cashflow(throttled) == []
        assert fcf.parse_quarterly_cashflow(no_cover) == []


class _FakeClient:
    def __init__(self, payload):
        self._payload = payload

    def call_tool(self, name, args):
        import json
        return json.dumps(self._payload)


class TestFetchSymbolRaisesOnThrottle:
    def test_raises_RateLimited_so_the_caller_can_tell_the_difference(self):
        client = _FakeClient({"error": True,
                              "message": "Too Many Requests. Rate limited. Try after a while."})
        with pytest.raises(fcf.RateLimited):
            fcf.fetch_symbol(client, "PRIVISCL")

    def test_no_coverage_still_returns_empty_list_not_an_exception(self):
        client = _FakeClient({"error": True, "message": "No cash flow data available"})
        assert fcf.fetch_symbol(client, "RELIANCE") == []


class TestStalenessSkipDegradesSafely:
    def test_unreadable_skip_list_fetches_everything_rather_than_nothing(self):
        """A failure to read the skip-list must degrade toward MORE work, never less.

        The dangerous inversion: returning a non-empty set on error would skip the whole
        universe and report a clean, empty success — the exact failure mode this session is
        fixing elsewhere.
        """
        class _BrokenConn:
            def cursor(self):
                raise RuntimeError("connection is gone")

        assert mf.recently_fetched(_BrokenConn(), 80) == set()
