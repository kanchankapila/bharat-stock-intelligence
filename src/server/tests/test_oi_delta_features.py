"""
Regression tests for oi_delta_features.py's write-target date (2026-08-01).

run()'s CLI default (no --date arg, which is exactly how ml-daily-ops invokes it) computed
`date_str = datetime.date.today().isoformat()` when no date was passed, then used that value
both to read stock_options_oi and as the exact `UPDATE ... WHERE date = ?` write target.
Whenever ml-daily-ops's step chain crosses midnight IST, that default silently targeted a day
with no OI/technical_signals rows yet, so both the read and the write returned empty -- no
error, no rows written. Must use as_of.logical_trading_date() instead.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import oi_delta_features as odf


class _FakeConn:
    def close(self):
        pass


class TestRunDefaultsToLogicalTradingDate:
    def _mock(self, monkeypatch, seen):
        monkeypatch.setattr(odf, "connect", lambda: _FakeConn())

        def _fake_compute(conn, date_str):
            seen["compute_date_str"] = date_str
            return pd.DataFrame(columns=["symbol", "oi_net_change_pct"])

        def _fake_write(conn, date_str, df):
            seen["write_date_str"] = date_str
            return 0

        monkeypatch.setattr(odf, "compute_oi_delta", _fake_compute)
        monkeypatch.setattr(odf, "write_features", _fake_write)

    def test_no_date_arg_uses_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(odf, "logical_trading_date", lambda: "2026-07-31")
        seen = {}
        self._mock(monkeypatch, seen)

        odf.run()  # mirrors `runPython('oi_delta_features.py', [], ...)` -- no --date arg

        assert seen["compute_date_str"] == "2026-07-31", (
            "run() must default to logical_trading_date(), not date.today()"
        )
        assert seen["write_date_str"] == "2026-07-31"

    def test_explicit_date_overrides_the_default(self, monkeypatch):
        monkeypatch.setattr(odf, "logical_trading_date", lambda: "2099-01-01")
        seen = {}
        self._mock(monkeypatch, seen)

        odf.run(date_str="2026-06-25")

        assert seen["compute_date_str"] == "2026-06-25"
        assert seen["write_date_str"] == "2026-06-25"


class TestWriteFeaturesUsesGivenDateStr:
    """write_features() itself is safe by construction -- it's parametrized on date_str, not
    computed internally. This documents that the bug was purely in run()'s default, not here."""

    def test_update_uses_the_passed_date_str(self):
        class _Cur:
            def __init__(self):
                self.calls = []
                self.rowcount = 0

            def executemany(self, sql, rows):
                self.calls.append((sql, rows))
                self.rowcount = len(rows)

        class _Conn:
            def __init__(self):
                self.cur = _Cur()

            def cursor(self):
                return self.cur

            def commit(self):
                pass

        conn = _Conn()
        df = pd.DataFrame([{"symbol": "INFY", "oi_net_change_pct": 3.5}])

        n = odf.write_features(conn, "2026-07-31", df)

        assert n == 1
        _, rows = conn.cur.calls[0]
        assert rows[0][-1] == "2026-07-31"
