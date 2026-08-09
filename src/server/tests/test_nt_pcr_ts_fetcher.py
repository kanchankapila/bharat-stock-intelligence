import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nt_pcr_ts_fetcher as npf


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _RetryStub:
    def __init__(self, fail_calls=0, payload=None):
        self.fail_calls = fail_calls
        self.payload = payload or {
            "result": 1,
            "resultData": {
                "oiExpiryDates": ["2026-08-27T00:00:00"],
                "oiDatas": [{"time": "2026-08-06 10:00:00", "expiry_date": "2026-08-27", "pcr": "1.02"}],
            },
        }
        self.calls = []

    def __call__(self, _requests_mod, url, **_kwargs):
        self.calls.append(url)
        if len(self.calls) <= self.fail_calls:
            raise Exception("HTTP 400")
        return _Resp(self.payload)


def test_candidate_urls_prefers_symbol_name_and_omits_blank_req_date():
    urls = npf._candidate_pcr_urls("NIFTY", "nse_pcr_data", "")
    assert urls, "no candidate URLs generated"
    assert "symbolName=NIFTY" in urls[0]
    assert "reqType=nse_pcr_data" in urls[0]
    # Primary candidate should omit reqDate entirely when empty.
    assert "reqDate=" not in urls[0]


def test_candidate_urls_include_fallback_keys_and_casing():
    urls = npf._candidate_pcr_urls("NIFTY", "nse_pcr_data", "")
    # Must include lower-case symbolName variant.
    assert any("symbolName=nifty" in u for u in urls)
    # Must include alternate symbol key fallback.
    assert any("symbol=nifty" in u or "symbol=NIFTY" in u for u in urls)


def test_fetch_pcr_falls_back_after_first_candidate_fails(monkeypatch):
    stub = _RetryStub(fail_calls=1)
    monkeypatch.setattr(npf, "retry_get", stub)

    expiries, data = npf.fetch_pcr("NIFTY", "nse_pcr_data", "")

    assert len(stub.calls) >= 2, "fallback candidate URL was not attempted after failure"
    assert expiries == ["2026-08-27T00:00:00"]
    assert isinstance(data, list) and data


def test_fetch_pcr_returns_empty_when_all_candidates_fail(monkeypatch):
    stub = _RetryStub(fail_calls=50)
    monkeypatch.setattr(npf, "retry_get", stub)

    expiries, data = npf.fetch_pcr("NIFTY", "nse_pcr_data", "")

    assert expiries == []
    assert data == []
