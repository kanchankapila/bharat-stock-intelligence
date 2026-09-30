"""Regression tests for nt_change_oi_fetcher.py.

2026-09-30 (AF-20260930-20): every stored calls/puts change-OI value was 0.0 because the request
used start_time == end_time == 15:20:00 -- a change over a zero-width window. Measured live: a
zero-width window returned 0 change on all 107 NIFTY strikes, 09:15 -> now returned 105 non-zero.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import nt_change_oi_fetcher as nt


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def _capture_url(monkeypatch):
    seen = []

    def fake_retry_get(_session, url, **_kw):
        seen.append(url)
        return _Resp({"result": 1, "resultData": []})

    monkeypatch.setattr(nt, "retry_get", fake_retry_get)
    return seen


class TestChangeWindow:
    def test_window_runs_from_market_open_to_the_snapshot(self, monkeypatch):
        seen = _capture_url(monkeypatch)
        nt.fetch_change_oi("nifty", "15:20:00", "nse")
        assert "start_time=09:15:00" in seen[0]
        assert "end_time=15:20:00" in seen[0]

    def test_window_is_never_zero_width(self, monkeypatch):
        seen = _capture_url(monkeypatch)
        nt.fetch_change_oi("banknifty", "14:00:00", "nse")
        start = seen[0].split("start_time=")[1].split("&")[0]
        end = seen[0].split("end_time=")[1].split("&")[0]
        assert start != end


class TestSave:
    def test_nonzero_changes_are_stored_as_given(self, monkeypatch):
        captured = []
        monkeypatch.setattr(nt, "executemany", lambda _sql, rows: captured.extend(rows))
        rec = {"strike_price": 23150, "expiry_date": "2026-10-06T00:00:00", "time": "2026-09-30T09:19:00",
               "index_close": 22695.5, "calls_change_oi": 148720, "calls_change_oi_value": 4141852,
               "puts_change_oi": -1365, "puts_change_oi_value": -576166.5}
        assert nt.save_change_oi("NIFTY50", [rec], "2026-09-30") == 1
        row = captured[0]
        assert row[6:10] == (148720.0, 4141852.0, -1365.0, -576166.5)
