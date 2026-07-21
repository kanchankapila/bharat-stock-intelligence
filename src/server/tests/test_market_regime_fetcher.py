import datetime
import os
import sys

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import market_regime_fetcher as mrf


class _FakeCffiResp:
    def __init__(self, payload=None, raise_status=False):
        self._payload = payload
        self._raise_status = raise_status

    def raise_for_status(self):
        if self._raise_status:
            raise Exception("boom")

    def json(self):
        return self._payload


class _FakeCffiReq:
    def __init__(self, resp):
        self._resp = resp

    def get(self, *a, **kw):
        return self._resp


class TestFetchUsdinr:
    """Regression test for the fix: the retired currency/get-currency-data endpoint
    returned nothing; us-markets/getCurrencies (the endpoint mc_global_macro_fetcher.py
    already used successfully) replaced it. This locks in the response-shape parsing,
    which accepts several field-name variants NSE/MC use across payload versions."""

    def test_finds_pair_via_pair_field(self, monkeypatch):
        monkeypatch.setattr(mrf, "cffi_requests", _FakeCffiReq(_FakeCffiResp(
            payload={"data": [{"pair": "USD/INR", "price": 83.42, "changePercent": 0.15}]})))
        assert mrf.fetch_usdinr() == (83.42, 0.15)

    def test_finds_pair_via_name_field_and_alt_keys(self, monkeypatch):
        monkeypatch.setattr(mrf, "cffi_requests", _FakeCffiReq(_FakeCffiResp(
            payload={"data": [{"name": "USD-INR", "ltp": 83.5, "pChg": -0.1}]})))
        assert mrf.fetch_usdinr() == (83.5, -0.1)

    def test_no_matching_pair_returns_none_none(self, monkeypatch):
        monkeypatch.setattr(mrf, "cffi_requests", _FakeCffiReq(_FakeCffiResp(
            payload={"data": [{"pair": "EUR/USD", "price": 1.1}]})))
        assert mrf.fetch_usdinr() == (None, None)

    def test_fetch_exception_returns_none_none(self, monkeypatch):
        monkeypatch.setattr(mrf, "cffi_requests", _FakeCffiReq(_FakeCffiResp(raise_status=True)))
        assert mrf.fetch_usdinr() == (None, None)


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def fetchone(self):
        return (self._value,) if self._value is not None else None


class _FakeConnCtx:
    def __init__(self, spot):
        self._spot = spot

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a, **kw):
        return _FakeResult(self._spot)


class _FakeEngine:
    def __init__(self, spot):
        self._spot = spot

    def connect(self):
        return _FakeConnCtx(self._spot)


_FUTURE_EXPIRY = (datetime.date.today() + datetime.timedelta(days=10)).isoformat() + "T00:00:00"


class TestFetchBasisFromNt:
    """Regression test for the fix: the NiftyTrader fallback used to read a
    resultData.data key that doesn't exist and expect spotPrice/futPrice fields NT's
    dashboard-data never returns. It now reads resultData.indices and pairs NT's
    futures last_trade_price with the NIFTY50 spot close already written to
    macro_indicators by global_macro_fetcher.py (dashboard-data carries no spot of
    its own)."""

    def test_happy_path_computes_annualized_basis_and_contango(self, monkeypatch):
        def _fake_get(*a, **kw):
            return _FakeCffiResp(payload={"result": 1, "resultData": {"indices": [
                {"symbol_name": "NIFTY", "last_trade_price": 25150.5, "expiry_date": _FUTURE_EXPIRY},
                {"symbol_name": "BANKNIFTY", "last_trade_price": 55000.0, "expiry_date": _FUTURE_EXPIRY},
            ]}})
        monkeypatch.setattr(requests, "get", _fake_get)
        monkeypatch.setattr(mrf, "get_engine", lambda: _FakeEngine(25000.0))
        basis, contango = mrf._fetch_basis_from_nt()
        assert basis == 21.973
        assert contango == 1

    def test_old_resultdata_data_shape_yields_none_none_not_raise(self, monkeypatch):
        def _fake_get(*a, **kw):
            return _FakeCffiResp(payload={"result": 1, "resultData": {
                "data": [{"spotPrice": 25000, "futPrice": 25100}]}})
        monkeypatch.setattr(requests, "get", _fake_get)
        monkeypatch.setattr(mrf, "get_engine", lambda: _FakeEngine(25000.0))
        assert mrf._fetch_basis_from_nt() == (None, None)

    def test_missing_nifty_entry_yields_none_none(self, monkeypatch):
        def _fake_get(*a, **kw):
            return _FakeCffiResp(payload={"result": 1, "resultData": {"indices": [
                {"symbol_name": "BANKNIFTY", "last_trade_price": 55000.0, "expiry_date": _FUTURE_EXPIRY},
            ]}})
        monkeypatch.setattr(requests, "get", _fake_get)
        monkeypatch.setattr(mrf, "get_engine", lambda: _FakeEngine(25000.0))
        assert mrf._fetch_basis_from_nt() == (None, None)

    def test_missing_spot_in_db_yields_none_none(self, monkeypatch):
        def _fake_get(*a, **kw):
            return _FakeCffiResp(payload={"result": 1, "resultData": {"indices": [
                {"symbol_name": "NIFTY", "last_trade_price": 25150.5, "expiry_date": _FUTURE_EXPIRY},
            ]}})
        monkeypatch.setattr(requests, "get", _fake_get)
        monkeypatch.setattr(mrf, "get_engine", lambda: _FakeEngine(None))
        assert mrf._fetch_basis_from_nt() == (None, None)

    def test_result_not_one_yields_none_none(self, monkeypatch):
        def _fake_get(*a, **kw):
            return _FakeCffiResp(payload={"result": 0})
        monkeypatch.setattr(requests, "get", _fake_get)
        assert mrf._fetch_basis_from_nt() == (None, None)
