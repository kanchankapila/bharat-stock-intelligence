"""AF-20261113-26: a Trendlyne 403/405/429 means the vendor refused this request class. Only
trendlyne_adv_tech_fetcher stopped at the first refusal; during the 2026-11-13..16 block the other
catch-up fetchers kept sending 60 to 110+ refused requests per hourly slice. Every Trendlyne fetcher
must stop asking once refused, and a fetcher that got nothing must not report success."""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import fetch_utils  # noqa: E402
import trendlyne_fno_activity_fetcher as fno  # noqa: E402
import trendlyne_fundamentals_fetcher as tlfund  # noqa: E402
import trendlyne_overview_fetcher as tlov  # noqa: E402
import trendlyne_price_analysis_fetcher as tlpa  # noqa: E402


class _Resp:
    def __init__(self, status=403):
        self.status_code = status
        self.ok = status < 400
        self.text = "{}"
        self.headers = {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error", response=self)

    def json(self):
        return {"head": {"status": "0"}, "body": {"k": 1}}


class _Session:
    def __init__(self, status=403):
        self.status = status
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        return _Resp(self.status)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(fetch_utils.time, "sleep", lambda s: None)


@pytest.mark.parametrize("status", [403, 405, 429])
def test_price_analysis_stops_on_a_bare_refusal_without_retrying(status):
    s = _Session(status)
    assert tlpa._fetch("533", s) is fetch_utils.WAF_BLOCKED
    assert s.calls == 1


def test_price_analysis_still_retries_a_server_error():
    s = _Session(503)
    assert tlpa._fetch("533", s) is None
    assert s.calls == 3


@pytest.mark.parametrize("mod, call", [
    (tlov, lambda m, s: m._fetch("https://trendlyne.com/x/533/", s)),
    (tlfund, lambda m, s: m._fetch("533", "EPS_TTM", s)),
])
def test_overview_and_fundamentals_send_nothing_after_the_first_refusal(mod, call, monkeypatch):
    monkeypatch.setattr(mod, "VENDOR_BLOCK", fetch_utils.VendorBlockLatch("test"))
    s = _Session(403)
    assert call(mod, s) is None
    assert mod.VENDOR_BLOCK.tripped()
    for _ in range(5):
        assert call(mod, s) is None
    assert s.calls == 1


def test_a_missing_row_does_not_trip_the_latch(monkeypatch):
    monkeypatch.setattr(tlov, "VENDOR_BLOCK", fetch_utils.VendorBlockLatch("test"))
    s = _Session(404)
    assert tlov._fetch("https://trendlyne.com/x/1/", s) is None
    assert tlov._fetch("https://trendlyne.com/x/2/", s) is None
    assert s.calls == 2 and not tlov.VENDOR_BLOCK.tripped()


def test_fno_activity_that_wrote_nothing_exits_non_zero(monkeypatch, capsys):
    s = _Session(403)
    monkeypatch.setattr(fno.requests, "get", s.get)
    monkeypatch.setattr(fno, "ensure_schema", lambda: None)
    monkeypatch.setattr(fno, "_get_nearest_monthly_expiry", lambda: "2026-11-23")
    with pytest.raises(SystemExit) as exc:
        fno.main([])
    assert exc.value.code == 1
    assert "HTTP 403" in capsys.readouterr().err


def test_option_chain_stops_at_the_first_refusal_and_fails_when_nothing_landed(monkeypatch, capsys):
    import so_option_chain_fetcher as so
    monkeypatch.setattr(so, "VENDOR_BLOCK", fetch_utils.VendorBlockLatch("test"))
    s = _Session(403)
    monkeypatch.setattr(so.requests, "get", s.get)
    monkeypatch.setattr(so, "is_trading_session", lambda d: True)
    monkeypatch.setattr(so, "_get_fno_symbols", lambda: ["AAA", "BBB", "CCC"])
    monkeypatch.setattr(so, "_coverage_map", lambda syms: {})
    monkeypatch.setattr(so, "resume_order", lambda syms, cov: syms)
    monkeypatch.setattr(so, "_get_nearest_expiry", lambda sym: "2026-11-24")
    with pytest.raises(SystemExit) as exc:
        so.run(delay=0)
    assert exc.value.code == 1
    assert s.calls == 1
    assert "HTTP 403" in capsys.readouterr().err
