"""Sub-project B.3: pre-open rows may only be stamped inside 09:00-09:20 IST (AF-20261008-23:
26 of 68 preopen_stock_snapshot dates were written outside the window, e.g. by a restart
catch-up). A call outside the window on a trading day writes nothing."""
import datetime

import preopen_fetcher as m

ITEMS = [{"metadata": {"symbol": "RELIANCE", "iep": "101", "previousClose": "100"}, "detail": {}}]


class _Cur:
    def __init__(self, log): self.log = log
    def execute(self, sql, params=()): self.log.append(sql)
    def executemany(self, sql, rows): self.log.append(sql)


class _Con:
    def __init__(self): self.log = []
    def cursor(self): return _Cur(self.log)
    def commit(self): pass
    def close(self): pass


def _setup(monkeypatch):
    monkeypatch.setattr(m, "is_trading_session", lambda d, conn=None: True)
    monkeypatch.setattr(m, "ensure_preopen_stock_schema", lambda con: None)
    monkeypatch.setattr(m, "ensure_schema", lambda con: None)
    monkeypatch.setattr(m, "_nse_session", lambda: None)
    monkeypatch.setattr(m, "_fetch_nse_preopen_url", lambda s, u: ITEMS)
    monkeypatch.setattr(m, "fetch_section", lambda url: [])


def _at(h, mi):
    return datetime.datetime(2026, 10, 8, h, mi)  # a Thursday session


def test_nse_preopen_outside_window_writes_nothing(monkeypatch):
    _setup(monkeypatch)
    con = _Con()
    assert m.fetch_nse_preopen(con, now=_at(11, 0)) == 0
    assert con.log == []


def test_nse_preopen_inside_window_writes(monkeypatch):
    _setup(monkeypatch)
    con = _Con()
    assert m.fetch_nse_preopen(con, now=_at(9, 10)) == 1
    assert any("preopen_stock_snapshot" in s for s in con.log)


def test_window_edges():
    assert m.in_preopen_window(_at(9, 0)) and m.in_preopen_window(_at(9, 20))
    assert not m.in_preopen_window(_at(8, 59)) and not m.in_preopen_window(_at(9, 21))


def test_run_outside_window_writes_nothing(monkeypatch):
    _setup(monkeypatch)
    con = _Con()
    monkeypatch.setattr(m, "connect", lambda: con)
    m.run(now=_at(11, 0))
    assert con.log == []


def test_run_inside_window_writes(monkeypatch):
    _setup(monkeypatch)
    con = _Con()
    monkeypatch.setattr(m, "connect", lambda: con)
    m.run(now=_at(9, 10))
    assert any("preopen_snapshot" in s for s in con.log)
    assert any("preopen_stock_snapshot" in s for s in con.log)
