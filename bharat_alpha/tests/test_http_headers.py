"""The implicit browser User-Agent is itself an added header, and one host hangs on it.

FRED black-holes a request carrying `User-Agent: Mozilla/5.0 ... Chrome/126` (measured
2026-09-29: bare request 200 in 0.1s, same request with the UA -> ReadTimeout). A silent
hang there costs the full retry budget and surfaces as "empty", not as a failure, so this
guards the suppression rather than the symptom.
"""
from __future__ import annotations

import pytest
import requests

from bharat_alpha.ingest.http import NO_BROWSER_UA, HttpClient


class _Recorder:
    """Stands in for requests.Session, capturing what the header merge actually produced."""

    def __init__(self):
        self.headers = requests.utils.default_headers()
        self.seen: dict | None = None

    def request(self, method, url, **kw):
        merged = requests.Session().prepare_request(
            requests.Request(method, url, headers={**self.headers, **(kw.get("headers") or {})})
        ).headers
        self.seen = merged
        r = requests.Response()
        r.status_code = 200
        return r


@pytest.fixture()
def client_with_recorder(monkeypatch):
    c = HttpClient(min_interval_s=0.0)
    rec = _Recorder()
    rec.headers.update(c.session.headers)
    monkeypatch.setattr(c, "_session_for", lambda host: rec)
    return c, rec


def test_browser_ua_suppressed_for_no_browser_ua_hosts(client_with_recorder):
    c, rec = client_with_recorder
    c.get("https://fred.stlouisfed.org/graph/fredgraph.csv", params={"id": "SP500"})
    assert "Mozilla" not in rec.seen.get("User-Agent", "")
    assert "Accept-Language" not in rec.seen


def test_browser_ua_still_sent_to_every_other_host(client_with_recorder):
    """Negative control: suppression must be scoped, or it silently breaks the WAF'd hosts."""
    c, rec = client_with_recorder
    c.get("https://www.moneycontrol.com/anything")
    assert "Mozilla" in rec.seen["User-Agent"]


def test_fred_is_registered():
    assert "fred.stlouisfed.org" in NO_BROWSER_UA
