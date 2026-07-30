import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import eps_surprise_fetcher as esf


class _FakeResp:
    def __init__(self, status_code=200, payload=None, raise_on_json=False):
        self.status_code = status_code
        self._payload = payload
        self._raise = raise_on_json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        if self._raise:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._payload


class _FakeCffi:
    def __init__(self, resp):
        self._resp = resp

    def get(self, *a, **kw):
        return self._resp


class TestFetchBulkDegradesGracefully:
    """Regression test for the fix: an uncaught JSON-decode error when MC's bulk
    actual-estimate endpoint returns empty/malformed used to kill the whole script.
    It now degrades to '0 stocks resolved' and continues."""

    def test_decode_failure_returns_empty_without_raising(self, monkeypatch):
        # status_code=200 (a "successful" response) with a malformed body — exercises the
        # JSON-decode-failure path specifically, distinct from an HTTP-error status (which
        # retry_get's own raise_for_status now intercepts before .json() is ever called).
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(status_code=200, raise_on_json=True)))
        features, history = esf.fetch_bulk({"SCID1": "RELIANCE"})
        assert features == {}
        assert history == []

    def test_http_error_status_returns_empty_without_raising(self, monkeypatch):
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(status_code=502)))
        features, history = esf.fetch_bulk({"SCID1": "RELIANCE"})
        assert features == {}
        assert history == []


_GOOD_PAYLOAD = {"data": {"list": [
    ["SCID1", None, None, None, None, "May 30, 2026", None, None, 12.5,
     [["Revenue", "1000", "900"], ["Net Profit", "150", "120"], ["EPS", "5", "4"]]],
]}}


class TestFetchBulkHappyPath:
    def test_resolves_known_scid_and_computes_features(self, monkeypatch):
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(payload=_GOOD_PAYLOAD)))
        features, history = esf.fetch_bulk({"SCID1": "RELIANCE"})
        assert "RELIANCE" in features
        assert features["RELIANCE"]["eps_surprise_q1"] == 12.5
        assert len(history) == 1
        assert history[0][0] == "SCID1" and history[0][1] == "RELIANCE"

    def test_unresolvable_scid_is_skipped(self, monkeypatch):
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(payload=_GOOD_PAYLOAD)))
        features, history = esf.fetch_bulk({})
        assert features == {}
        assert history == []


class TestSafeFloat:
    def test_valid_numeric_string(self):
        assert esf._safe_float("1,234.5") == 1234.5

    def test_dash_sentinel_returns_none(self):
        assert esf._safe_float("--") is None

    def test_none_returns_none(self):
        assert esf._safe_float(None) is None

    def test_garbage_returns_none_not_raise(self):
        assert esf._safe_float("not-a-number") is None
