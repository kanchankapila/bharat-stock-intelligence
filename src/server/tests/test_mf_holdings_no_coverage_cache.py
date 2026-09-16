"""mf_holdings_fetcher must tell a THROTTLED/failed response apart from a genuinely-empty one.

The bug (measured live 2026-09-10): the staleness skip is built from symbols successfully
WRITTEN, so any symbol the vendor has no MF data for never enters it and is re-crawled on every
single run. Universe 2,366; ever written 1,403; **never written 1,037 (44%)** -- re-fetched
forever, for nothing. That is what grew the job past its 20-minute budget and failed
ml-weekly-retrain (`Timed out after 1200000ms`).

The obvious fix -- cache "no data" -- is a trap, and `.claude/rules/recurring-bugs.md` names it:
"A THROTTLED vendor response and a genuinely-empty one must not collapse to the same value."
`fetch_mf_holding` returned a bare `None` for all three of (a) HTTP != 200, (b) a clean 200 with
no MF holdings, (c) any exception. Caching that indiscriminately would permanently suppress
symbols that DO have data, the moment the vendor rate-limits us -- converting a transient outage
into silent permanent data loss, which is strictly worse than the wasted requests.

So the verdict is classified first, and only `empty` is cacheable.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mf_holdings_fetcher as mf


class _Resp:
    def __init__(self, status=200, payload=None, boom=None):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self._boom = boom

    def json(self):
        if self._boom:
            raise ValueError(self._boom)
        return self._payload


class _Session:
    def __init__(self, resp=None, boom=None):
        self._resp = resp
        self._boom = boom

    def get(self, *a, **k):
        if self._boom:
            raise ConnectionError(self._boom)
        return self._resp


_REAL = {
    "summary": {"mf": {"percentage": 12.5, "changeQoQ": 0.4}},
    "quarterDates": [{"date": 1782777600000}],
}


def test_a_real_holding_is_classified_ok():
    verdict, payload = mf.fetch_mf_holding("INFY", "9195", _Session(_Resp(200, _REAL)))
    assert verdict == "ok"
    assert payload["symbol"] == "INFY"
    assert payload["mf_holding_pct"] == 12.5


def test_a_clean_200_with_no_mf_holdings_is_empty_and_cacheable():
    """The genuine case: vendor answered fine, this stock simply has no MF holdings."""
    verdict, payload = mf.fetch_mf_holding("3PLAND", "1", _Session(_Resp(200, {"summary": {}})))
    assert verdict == "empty", "a clean 200 with no MF data is the one cacheable verdict"
    assert payload is None
    assert mf.is_cacheable_verdict("empty") is True


def test_a_throttled_response_is_an_error_and_is_NOT_cacheable():
    """429 is the whole reason this classification exists -- caching it loses real data."""
    verdict, _ = mf.fetch_mf_holding("INFY", "9195", _Session(_Resp(429, {})))
    assert verdict == "error", "HTTP 429 must never be read as 'this stock has no MF holdings'"
    assert mf.is_cacheable_verdict("error") is False


@pytest.mark.parametrize("status", [500, 503, 404, 403])
def test_other_non_200_responses_are_errors_not_empty(status):
    verdict, _ = mf.fetch_mf_holding("INFY", "9195", _Session(_Resp(status, {})))
    assert verdict == "error", f"HTTP {status} must not be cached as empty"


def test_a_transport_exception_is_an_error_not_empty():
    verdict, _ = mf.fetch_mf_holding("INFY", "9195", _Session(boom="connection reset"))
    assert verdict == "error"
    assert mf.is_cacheable_verdict("error") is False


def test_unparseable_json_is_an_error_not_empty():
    verdict, _ = mf.fetch_mf_holding("INFY", "9195", _Session(_Resp(200, boom="not json")))
    assert verdict == "error", "a 200 we could not parse is not evidence of 'no holdings'"
