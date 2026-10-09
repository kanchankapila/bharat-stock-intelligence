"""Audit C-04 (2026-10-08): F&O / pre-open / breadth writers stamped CALENDAR dates.

The daily chain also runs on closed days, so stock_futures_oi_history carried 4 non-trading
dates (09-05 Sat, 09-06 Sun, 10-02 holiday, 10-04 Sun) -- 10-02 and 10-04 byte-identical
copies of 10-01 -- and nt_fno_dashboard / so_stock_oi_summary / ndtv_fno_basis / market_breadth
the same. Each writer must write NOTHING when its session date is not an NSE session.

Per-writer tests force `is_trading_session` False via monkeypatch(raising=False): against the
unfixed module the patched name is simply unused, so the write happens and the test fails.
"""
import datetime
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import as_of  # noqa: E402
from pg_test_support import pg_memory_conn  # noqa: E402

SUNDAY = datetime.datetime(2026, 10, 4, 18, 0)


def _closed(monkeypatch, mod):
    monkeypatch.setattr(mod, "is_trading_session", lambda *a, **k: False, raising=False)


def _boom(*a, **k):
    raise AssertionError("writer wrote on a non-trading day")


# -- the shared calendar helper ------------------------------------------------------------

class TestIsTradingSession:
    def test_weekend_needs_no_db(self):
        assert as_of.is_trading_session("2026-10-04") is False   # Sunday
        assert as_of.is_trading_session("2026-09-05") is False   # Saturday

    def test_known_holiday_and_ordinary_weekday(self):
        conn = pg_memory_conn()
        conn.execute("CREATE TABLE market_holidays (date DATE NOT NULL, exchange TEXT NOT NULL, "
                     "description TEXT)")
        conn.execute("INSERT INTO market_holidays (date, exchange, description) VALUES (?, ?, ?)",
                     ("2026-10-02", "NSE", "Mahatma Gandhi Jayanti"))
        assert as_of.is_trading_session("2026-10-02", conn) is False
        assert as_of.is_trading_session("2026-10-01", conn) is True


# -- the writers -----------------------------------------------------------------------------

def test_futures_oi_skips_non_trading_day(monkeypatch):
    import mc_stock_futures_oi_fetcher as m
    written = []
    monkeypatch.setattr(m, "ensure_schema", lambda: None)
    monkeypatch.setattr(m, "load_mc_symbol_map", lambda s=None: {"RELIANCE": "RI"})
    monkeypatch.setattr(m, "fetch_symbol", lambda sc, as_of=None: [
        {"expiry": "2026-10-27", "open_interest": 1.0, "oi_change": 0.0, "oi_pct_change": 0.0,
         "oi_buildup": None, "rollover_pct": None, "oi_pcr": None, "futures_price": 1010.0,
         "spot_price": 1000.0, "basis": 10.0, "contracts": None, "futures_volume": None,
         "lot_size": None}])
    monkeypatch.setattr(m, "write_rows", lambda rows, as_of: written.extend(rows) or len(rows))
    assert m.run(now=SUNDAY, sleep=0) == 0
    assert written == []


def test_futures_oi_still_writes_on_a_session(monkeypatch):
    """Control: the guard must not block a real session (Thursday 2026-10-01)."""
    import mc_stock_futures_oi_fetcher as m
    monkeypatch.setattr(m, "is_trading_session", lambda *a, **k: True, raising=False)
    monkeypatch.setattr(m, "ensure_schema", lambda: None)
    monkeypatch.setattr(m, "load_mc_symbol_map", lambda s=None: {"RELIANCE": "RI"})
    monkeypatch.setattr(m, "fetch_symbol", lambda sc, as_of=None: [{"expiry": "2026-10-27"}])
    seen = {}
    monkeypatch.setattr(m, "write_rows", lambda rows, as_of: seen.update(as_of=as_of) or len(rows))
    assert m.run(now=datetime.datetime(2026, 10, 1, 18, 0), sleep=0) == 1
    assert seen["as_of"] == "2026-10-01"


def test_ndtv_basis_skips_non_trading_day_and_exits_clean(monkeypatch):
    import ndtv_fno_basis_fetcher as m
    _closed(monkeypatch, m)
    monkeypatch.setattr(m, "load_fno_symbols", lambda: ["RELIANCE"])
    monkeypatch.setattr(m, "fetch_one", lambda s, sym: {"x": 1})
    monkeypatch.setattr(m, "parse_summary", lambda sym, p: {"symbol": sym})
    monkeypatch.setattr(m, "_get_session", lambda: None)
    monkeypatch.setattr(m, "connect", _boom)
    monkeypatch.setattr(m, "store", _boom)
    # A deliberate skip is not a failure: main() must not exit 1 ("nothing stored").
    assert m.main() == 0


def test_so_option_chain_skips_non_trading_day(monkeypatch):
    import so_option_chain_fetcher as m
    _closed(monkeypatch, m)
    monkeypatch.setattr(m, "_get_nearest_expiry", lambda s, exchange="NSE": "2026-10-27")
    monkeypatch.setattr(m, "fetch_chain", lambda s, e: {"body": {}})
    monkeypatch.setattr(m, "_parse_chain", lambda b, s, t, e: ([("row",)], None))
    monkeypatch.setattr(m, "save_chain", _boom)
    m.run(target_symbol="RELIANCE", delay=0)


def test_nt_dashboard_skips_non_trading_day(monkeypatch):
    import nt_dashboard_fetcher as m
    _closed(monkeypatch, m)

    class _Con:
        def close(self):
            pass
    monkeypatch.setattr(m, "connect", lambda: _Con())
    monkeypatch.setattr(m, "ensure_schema", lambda con: None)
    monkeypatch.setattr(m, "logical_write_floor", lambda **k: "2026-10-01")
    monkeypatch.setattr(m, "_fetch_all", lambda: {"stocks": [{"symbol_name": "BEL"}], "indices": []})
    monkeypatch.setattr(m, "_parse_record", lambda row, today: {"symbol": "BEL"})
    monkeypatch.setattr(m, "upsert_row", _boom)
    monkeypatch.setattr(m, "backfill_technical_signals", _boom)
    monkeypatch.setattr(sys, "argv", ["nt_dashboard_fetcher.py"])
    m.main()


def test_preopen_stock_snapshot_skips_non_trading_day(monkeypatch):
    import preopen_fetcher as m
    _closed(monkeypatch, m)
    monkeypatch.setattr(m, "ensure_preopen_stock_schema", lambda con: None)
    monkeypatch.setattr(m, "_nse_session", lambda: None)
    monkeypatch.setattr(m, "_fetch_nse_preopen_url", lambda s, u: [
        {"metadata": {"symbol": "RELIANCE", "iep": "101", "previousClose": "100"}, "detail": {}}])

    class _Con:
        def cursor(self):
            raise AssertionError("writer wrote on a non-trading day")
    import datetime
    # inside the 09:00-09:20 window, so only the trading-day check can be what skips the write
    assert m.fetch_nse_preopen(_Con(), now=datetime.datetime(2026, 10, 4, 9, 10)) == 0


def test_advance_decline_skips_non_trading_day(monkeypatch):
    import mc_advance_decline_fetcher as m
    _closed(monkeypatch, m)
    monkeypatch.setattr(m, "ensure_schema", lambda: None)
    monkeypatch.setattr(m, "fetch_adv_dec", lambda s, ex: {
        "date": "2026-10-04", "advances": 1, "declines": 1, "unchanged": 0, "ratio": 0.5})
    monkeypatch.setattr(m, "upsert_adv_dec", _boom)
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    m.main()
