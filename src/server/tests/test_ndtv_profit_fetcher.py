"""Regression tests for ndtv_profit_fetcher.py -- fixtures are real payloads captured live 2026-09-30.

AF-20260930-21: fetch_stock_summary() hit `/api/v2/stocks/<sym>/` (an HTML web page, never JSON)
and fetch_open_interest() sent `duration=15d`, which the API answers with `{"data":[]}` -- its
`duration` is the EXPIRY month (`1m`/`2m`), and each row is one strike's call OR put OI.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ndtv_profit_fetcher as ndtv

SUMMARY = {"responseCode": 200, "data": {
    "basis": 7.8, "symbol": "RELIANCE", "spot-price": 1192.7, "1m-future": 1200.5,
    "2m-future": 1206.4, "roll-spread": 5.9, "roll-over-percentage": 9.17,
    "open-interest": 293648, "open-interest-change-percentage": 0.3, "put-call-ratio": 0.74},
    "broadcasted-at": "2026-09-30T09:42:21.104890280"}

OI = {"responseCode": 200, "data": [
    {"symbol": "RELIANCE", "type": "call", "expiry": "1m", "expiry-date": "2026-10-27",
     "strike-price": 1090, "open-interest": 0, "open-interest-change": 0,
     "open-interest-change-percentage": "NaN"},
    {"symbol": "RELIANCE", "type": "put", "expiry": "1m", "expiry-date": "2026-10-27",
     "strike-price": 1090, "open-interest": 99, "open-interest-change": 41,
     "open-interest-change-percentage": 0.7068965517241379},
    {"symbol": "RELIANCE", "type": "call", "expiry": "1m", "expiry-date": "2026-10-27",
     "strike-price": 1200, "open-interest": 5120, "open-interest-change": -300,
     "open-interest-change-percentage": -0.055},
]}


class _Resp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def json(self):
        return self._payload


class _Session:
    def __init__(self, payload):
        self.payload, self.urls = payload, []

    def get(self, url, timeout=None):
        self.urls.append(url)
        return _Resp(self.payload)


def _patch(monkeypatch, payload):
    sess = _Session(payload)
    monkeypatch.setattr(ndtv, "_get_session", lambda: (sess, "test"))
    return sess


class TestStockSummary:
    def test_calls_the_json_api_route_not_the_html_page(self, monkeypatch):
        sess = _patch(monkeypatch, SUMMARY)
        ndtv.fetch_stock_summary("reliance")
        assert "/stock-summary?symbol=RELIANCE" in sess.urls[0]

    def test_maps_the_real_fields(self, monkeypatch):
        _patch(monkeypatch, SUMMARY)
        s = ndtv.fetch_stock_summary("RELIANCE")
        assert s["symbol"] == "RELIANCE"
        assert s["pcr_oi"] == 0.74
        assert s["basis_points"] == 7.8
        assert s["open_interest"] == 293648
        assert s["rollover_pct"] == 9.17
        assert s["spot_price"] == 1192.7


class TestOpenInterest:
    def test_duration_is_an_expiry_month(self, monkeypatch):
        sess = _patch(monkeypatch, OI)
        ndtv.fetch_open_interest("RELIANCE")
        assert "duration=1m" in sess.urls[0] and "stock=RELIANCE" in sess.urls[0]

    def test_one_row_per_strike_with_call_and_put_side_by_side(self, monkeypatch):
        _patch(monkeypatch, OI)
        df = ndtv.fetch_open_interest("RELIANCE")
        assert list(df["strike"]) == [1090, 1200]
        r1090 = df[df["strike"] == 1090].iloc[0]
        assert r1090["call_oi"] == 0 and r1090["put_oi"] == 99
        assert r1090["put_oi_change"] == 41
        assert str(r1090["expiry_date"])[:10] == "2026-10-27"

    def test_missing_side_is_null_not_zero(self, monkeypatch):
        _patch(monkeypatch, OI)
        df = ndtv.fetch_open_interest("RELIANCE")
        r1200 = df[df["strike"] == 1200].iloc[0]
        assert r1200["put_oi"] is None or r1200["put_oi"] != r1200["put_oi"]  # None or NaN, never 0

    def test_nan_string_is_not_a_number(self, monkeypatch):
        _patch(monkeypatch, OI)
        df = ndtv.fetch_open_interest("RELIANCE")
        v = df[df["strike"] == 1090].iloc[0]["call_oi_change_pct"]
        assert v is None or v != v

    def test_empty_payload_returns_none(self, monkeypatch):
        _patch(monkeypatch, {"data": []})
        assert ndtv.fetch_open_interest("RELIANCE") is None
