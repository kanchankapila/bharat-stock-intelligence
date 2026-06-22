"""
TDD tests for intraday_fetcher.py.

Pure-function tests (parse_bars) need no DB.
DB-integration tests use a temp SQLite via DATABASE_URL injection.
No network calls: fetch_fn is injected via run(fetch_fn=...).
"""

import importlib
import os
import sqlite3
import sys
import tempfile

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import intraday_fetcher as itf


# ── Pure-function tests ───────────────────────────────────────────────────────

class TestParseBars:
    def _mc_payload(self, n=3, base_ts=1_750_000_000):
        """Build a minimal MC TechCharts JSON payload with n bars."""
        return {
            "t": [base_ts + i * 900 for i in range(n)],   # 15-min steps
            "o": [100.0 + i for i in range(n)],
            "h": [105.0 + i for i in range(n)],
            "l": [98.0  + i for i in range(n)],
            "c": [103.0 + i for i in range(n)],
            "v": [10000 + i * 100 for i in range(n)],
        }

    def test_returns_correct_bar_count(self):
        bars = itf.parse_bars(self._mc_payload(5), "INFY")
        assert len(bars) == 5

    def test_bar_fields_present(self):
        bars = itf.parse_bars(self._mc_payload(1), "INFY")
        b = bars[0]
        assert set(b.keys()) >= {"symbol", "datetime", "open", "high", "low", "close", "volume", "interval"}

    def test_symbol_and_interval_set(self):
        bars = itf.parse_bars(self._mc_payload(1), "RELIANCE", interval="15m")
        assert bars[0]["symbol"]   == "RELIANCE"
        assert bars[0]["interval"] == "15m"

    def test_ohlcv_values_correct(self):
        bars = itf.parse_bars(self._mc_payload(1, base_ts=1_750_000_000), "X")
        assert bars[0]["open"]   == pytest.approx(100.0)
        assert bars[0]["high"]   == pytest.approx(105.0)
        assert bars[0]["low"]    == pytest.approx(98.0)
        assert bars[0]["close"]  == pytest.approx(103.0)
        assert bars[0]["volume"] == 10000

    def test_datetime_is_iso_string_with_tz(self):
        bars = itf.parse_bars(self._mc_payload(1), "X")
        dt = bars[0]["datetime"]
        assert isinstance(dt, str)
        assert "+05:30" in dt or "T" in dt   # IST offset or ISO format

    def test_returns_empty_list_for_none(self):
        assert itf.parse_bars(None, "X") == []

    def test_returns_empty_list_for_missing_t_array(self):
        assert itf.parse_bars({}, "X") == []

    def test_returns_empty_list_for_empty_t_array(self):
        assert itf.parse_bars({"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}, "X") == []


# ── DB-integration tests ──────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _restore_db_env():
    saved = {k: os.environ.get(k) for k in ("DATABASE_URL", "USE_POSTGRES")}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    import db_compat
    importlib.reload(db_compat)


def _make_db(symbols_with_mc: list) -> tuple:
    path = os.path.join(tempfile.mkdtemp(), "intra_test.sqlite")
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE nse_stocks (
            symbol TEXT PRIMARY KEY, mcsymbol TEXT, name TEXT, status TEXT
        );
        CREATE TABLE intraday_ohlcv (
            symbol   TEXT NOT NULL,
            datetime TEXT NOT NULL,
            open     REAL,
            high     REAL,
            low      REAL,
            close    REAL,
            volume   INTEGER,
            vwap     REAL,
            interval TEXT NOT NULL DEFAULT '15m',
            PRIMARY KEY (symbol, datetime, interval)
        );
    """)
    for symbol, mcsymbol in symbols_with_mc:
        con.execute("INSERT INTO nse_stocks (symbol, mcsymbol, status) VALUES (?, ?, 'ACTIVE')", (symbol, mcsymbol))
    con.commit()

    os.environ.pop("USE_POSTGRES", None)
    os.environ["DATABASE_URL"] = f"sqlite:///{path}"
    import db_compat
    importlib.reload(db_compat)
    importlib.reload(itf)
    return path, con


def _good_fetch(mcsymbol, from_ts, to_ts):
    """Returns a 3-bar payload regardless of timestamps."""
    base = 1_750_000_000
    return {
        "t": [base, base + 900, base + 1800],
        "o": [100.0, 101.0, 102.0],
        "h": [105.0, 106.0, 107.0],
        "l": [98.0,  99.0, 100.0],
        "c": [103.0, 104.0, 105.0],
        "v": [10000, 11000, 12000],
    }


def _empty_fetch(mcsymbol, from_ts, to_ts):
    return None


class TestRunDb:
    def test_writes_bars_for_covered_symbols(self):
        _, con = _make_db([("INFY", "IT"), ("TCS", "TCS01")])
        n = itf.run(fetch_fn=_good_fetch)
        assert n == 6   # 3 bars × 2 symbols
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv").fetchone()[0] == 6

    def test_upsert_same_bars_no_duplicate(self):
        _, con = _make_db([("INFY", "IT")])
        itf.run(fetch_fn=_good_fetch)
        itf.run(fetch_fn=_good_fetch)
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv").fetchone()[0] == 3

    def test_skips_symbols_without_mcsymbol(self):
        _, con = _make_db([("INFY", "IT"), ("NOCOVER", None)])
        n = itf.run(fetch_fn=_good_fetch)
        assert n == 3   # only INFY
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv WHERE symbol='NOCOVER'").fetchone()[0] == 0

    def test_skips_symbols_with_no_data(self):
        _, con = _make_db([("INFY", "IT")])
        n = itf.run(fetch_fn=_empty_fetch)
        assert n == 0

    def test_stores_symbol_and_interval(self):
        _, con = _make_db([("INFY", "IT")])
        itf.run(fetch_fn=_good_fetch)
        row = con.execute("SELECT symbol, interval FROM intraday_ohlcv LIMIT 1").fetchone()
        assert row[0] == "INFY"
        assert row[1] == "15m"

    def test_returns_total_bar_count(self):
        _, con = _make_db([("INFY", "IT"), ("TCS", "TCS01"), ("HDFC", "HDF01")])
        n = itf.run(fetch_fn=_good_fetch)
        assert n == 9   # 3 bars × 3 symbols
