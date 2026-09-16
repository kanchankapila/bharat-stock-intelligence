"""AF-20260912-09 negative control.

`fetch_niftytrader()` began with `if not bearer: return []`, on the belief that
NT_GAINERS_URL requires a Bearer token. Isolated live 2026-09-12 one header at a time, it
does not -- the `sec-fetch-*` trio is what the route gates on:

    token + sec-fetch   -> 200 (25,227 bytes)
    sec-fetch, NO token -> 200 (25,227 bytes, identical)
    token, no sec-fetch -> 403
    neither             -> 403

So a lapsed/cleared token silently produced ZERO rows from a fully-accessible endpoint.
Live after the fix, with the token forced to None: 86 rows.

Restore the `if not bearer: return []` guard and test_no_token_still_issues_the_request fails.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import mover_screener_fetcher as m  # noqa: E402


class _StubResp:
    status_code = 200

    @staticmethod
    def raise_for_status():
        return None

    @staticmethod
    def json():
        return {"resultData": {"topGainers": [
            {"symbol_name": "AWFIS", "today_open": 248.5, "today_high": 299.45,
             "today_low": 244.1, "today_close": 292.0, "per_chg": 17.47},
        ]}}


class _StubSession:
    def __init__(self):
        self.requests = []

    def get(self, url, headers=None, timeout=None):
        self.requests.append((url, headers or {}))
        return _StubResp()


def test_no_token_still_issues_the_request(monkeypatch):
    """The load-bearing case: no token must NOT mean no attempt."""
    monkeypatch.setattr(m, "_nt_bearer_token", lambda: None)
    sess = _StubSession()
    rows = m.fetch_niftytrader(sess)
    assert sess.requests, (
        "no HTTP request was issued without a token -- the endpoint is reachable "
        "anonymously, so skipping it silently drops every row it would have returned"
    )
    assert rows, "parsed no rows from a healthy response"


def test_sec_fetch_headers_are_always_sent(monkeypatch):
    """These, not the token, are what the route actually gates on."""
    monkeypatch.setattr(m, "_nt_bearer_token", lambda: None)
    sess = _StubSession()
    m.fetch_niftytrader(sess)
    _, headers = sess.requests[0]
    for h in ("sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"):
        assert h in headers, f"{h} missing; the route 403s without it"
    assert "Authorization" not in headers, "no token was available, so none should be sent"


def test_token_is_still_sent_when_one_exists(monkeypatch):
    monkeypatch.setattr(m, "_nt_bearer_token", lambda: "tok123")
    sess = _StubSession()
    m.fetch_niftytrader(sess)
    _, headers = sess.requests[0]
    assert headers.get("Authorization") == "Bearer tok123"
