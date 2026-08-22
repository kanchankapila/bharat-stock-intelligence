"""
TDD tests for intraday_fetcher.py.

Pure-function tests (parse_bars) need no DB.
DB-integration tests use a temp SQLite via DATABASE_URL injection.
No network calls: fetch_fn is injected via run(fetch_fn=...).
"""

import importlib
import os
import sys
import uuid

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import intraday_fetcher as itf


# ── Pure-function tests ───────────────────────────────────────────────────────

# 2026-06-15 09:15:00 IST -- an NSE session open, exactly on the 15-minute bar grid.
# parse_bars now rejects off-grid timestamps (vendors append the current in-progress quote
# stamped at request time) and only emits VWAP for sessions whose opening bar is present, so
# fixtures must start at a real session open rather than an arbitrary epoch.
SESSION_OPEN_TS = 1_781_495_100


class TestParseBars:
    def _mc_payload(self, n=3, base_ts=SESSION_OPEN_TS):
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
        bars = itf.parse_bars(self._mc_payload(1, base_ts=SESSION_OPEN_TS), "X")
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


class TestOffGridBarsRejected:
    """Both vendors append the current in-progress quote to the history array stamped at
    request time rather than on the bar grid -- a real 09:30:00 bar plus a bogus 09:30:20 one
    with volume 0 and open==high==low==close. Written verbatim these accounted for 5.5% of all
    July 2026 rows and ~1 junk row per real bar for actively-fetched names (RELIANCE: 49 rows
    for a 25-bar session). They are not bars."""

    def _payload_with_snapshot(self):
        # two real grid bars, plus the vendor's synthetic "last price" quote 20s into bar 3
        return {
            "t": [SESSION_OPEN_TS, SESSION_OPEN_TS + 900, SESSION_OPEN_TS + 1800 + 20],
            "o": [100.0, 101.0, 102.0],
            "h": [105.0, 106.0, 102.0],
            "l": [98.0,  99.0,  102.0],
            "c": [103.0, 104.0, 102.0],
            "v": [10000, 11000, 0],
        }

    def test_off_grid_snapshot_bar_is_dropped(self):
        bars = itf.parse_bars(self._payload_with_snapshot(), "X")
        assert len(bars) == 2
        assert all(b["datetime"].endswith(":00+05:30") for b in bars)
        assert not any(b["datetime"][11:19].endswith(":20") for b in bars)

    def test_on_grid_bars_survive_unchanged(self):
        bars = itf.parse_bars(self._payload_with_snapshot(), "X")
        assert [b["volume"] for b in bars] == [10000, 11000]

    def test_unknown_interval_does_not_silently_discard(self):
        """A grid can only be enforced for known intervals -- an unrecognised label must pass
        data through rather than delete it."""
        bars = itf.parse_bars(self._payload_with_snapshot(), "X", interval="7m")
        assert len(bars) == 3


class TestSessionVwap:
    """intraday_ohlcv.vwap was written as a literal NULL for every row until 2026-07-31, which
    silently made intraday_features.py's vwap_deviation_pct a constant 0.0 for every symbol on
    every session while still looking populated."""

    def _session(self, n=3, base_ts=SESSION_OPEN_TS):
        return {
            "t": [base_ts + i * 900 for i in range(n)],
            "o": [100.0] * n,
            "h": [110.0] * n,
            "l": [90.0] * n,
            "c": [100.0] * n,
            "v": [1000] * n,
        }

    def test_vwap_is_populated(self):
        bars = itf.parse_bars(self._session(3), "X")
        assert all(b["vwap"] is not None for b in bars)

    def test_vwap_equals_typical_price_for_constant_bars(self):
        # typical price = (110 + 90 + 100) / 3 = 100 on every bar, so VWAP must be exactly 100
        bars = itf.parse_bars(self._session(3), "X")
        assert all(b["vwap"] == pytest.approx(100.0) for b in bars)

    def test_vwap_accumulates_and_is_volume_weighted(self):
        p = self._session(2)
        p["h"] = [110.0, 230.0]; p["l"] = [90.0, 190.0]; p["c"] = [100.0, 210.0]
        p["v"] = [1000, 3000]
        bars = itf.parse_bars(p, "X")
        # bar1 typical 100 (vol 1000); bar2 typical 210 (vol 3000)
        # cumulative VWAP after bar2 = (100*1000 + 210*3000) / 4000 = 182.5
        assert bars[0]["vwap"] == pytest.approx(100.0)
        assert bars[1]["vwap"] == pytest.approx(182.5)

    def test_vwap_is_null_when_session_open_bar_absent(self):
        """The earliest day of any lookback window is partial. Accumulating from an arbitrary
        mid-session bar produces a confidently wrong VWAP, and the upsert would overwrite a
        previously-correct value with it -- so emit NULL instead."""
        bars = itf.parse_bars(self._session(3, base_ts=SESSION_OPEN_TS + 3 * 3600), "X")
        assert bars, "mid-session bars should still be written"
        assert all(b["vwap"] is None for b in bars)

    def test_known_open_days_widens_trust_beyond_this_payload(self):
        """A later fetch cycle's own payload can genuinely omit the open bar for an illiquid
        name even though an earlier cycle already captured it and it's sitting in the DB --
        found live 2026-08-09: ~16% of a session's bars sat NULL for exactly this reason.
        known_open_days lets run() tell parse_bars "trust this day anyway"."""
        import datetime as _dt
        mid_session = self._session(3, base_ts=SESSION_OPEN_TS + 3 * 3600)
        without_hint = itf.parse_bars(mid_session, "X")
        assert all(b["vwap"] is None for b in without_hint), "sanity: absent the hint, still NULL"

        session_date = _dt.datetime.fromtimestamp(SESSION_OPEN_TS, tz=itf._IST).date()
        with_hint = itf.parse_bars(mid_session, "X", known_open_days={session_date})
        assert all(b["vwap"] is not None for b in with_hint)

    def test_known_open_days_for_a_different_date_does_not_help(self):
        """The hint is per-date -- knowing yesterday had an open bar must not validate today's
        VWAP if today's own payload never showed an open bar."""
        import datetime as _dt
        mid_session = self._session(3, base_ts=SESSION_OPEN_TS + 3 * 3600)
        wrong_date = _dt.datetime.fromtimestamp(SESSION_OPEN_TS - 86400, tz=itf._IST).date()
        bars = itf.parse_bars(mid_session, "X", known_open_days={wrong_date})
        assert all(b["vwap"] is None for b in bars)

    def test_vwap_resets_across_sessions(self):
        day1 = self._session(2, SESSION_OPEN_TS)
        day2 = self._session(2, SESSION_OPEN_TS + 86400)
        merged = {k: day1[k] + day2[k] for k in day1}
        merged["h"] = [110.0, 110.0, 230.0, 230.0]
        merged["l"] = [90.0, 90.0, 190.0, 190.0]
        merged["c"] = [100.0, 100.0, 210.0, 210.0]
        bars = itf.parse_bars(merged, "X")
        assert bars[1]["vwap"] == pytest.approx(100.0)
        # day 2 must not inherit day 1's accumulation
        assert bars[3]["vwap"] == pytest.approx(210.0)


# ── DB-integration tests ──────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _restore_db_env():
    """Repoint POSTGRES_URL at a throwaway Postgres schema per test; restore + invalidate engine cache after."""
    import psycopg2
    from pg_test_support import _pg_dsn, _sa_url, pg_available, drop_throwaway_schema
    if not pg_available():
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")
    saved = {k: os.environ.get(k) for k in ("POSTGRES_URL", "USE_POSTGRES", "DATABASE_URL")}
    schema = f"t_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(**_pg_dsn())
    admin.autocommit = True
    admin.cursor().execute(f'CREATE SCHEMA "{schema}"')
    os.environ["USE_POSTGRES"] = "true"
    os.environ["POSTGRES_URL"] = _sa_url(schema)
    os.environ.pop("DATABASE_URL", None)
    yield
    import db_compat
    # MUST precede the DROP: pooled connections still scoped to this schema hold
    # AccessShareLocks on its tables, and DROP SCHEMA CASCADE needs AccessExclusiveLock.
    # reload() alone abandons the old engine cache with its sockets open. See dispose_engines().
    db_compat.dispose_engines()
    try:
        drop_throwaway_schema(admin, schema)
    finally:
        admin.close()
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    importlib.reload(db_compat)


def _make_db(symbols_with_mc: list):
    """Create nse_stocks + intraday_ohlcv in the throwaway Postgres schema.
    Returns a ConnWrapper for assertions."""
    import db_compat
    importlib.reload(db_compat)
    importlib.reload(itf)
    con = db_compat.connect()
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
    return con


def _good_fetch(mcsymbol, from_ts, to_ts):
    """Returns a 3-bar payload regardless of timestamps."""
    base = SESSION_OPEN_TS
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
        con = _make_db([("INFY", "IT"), ("TCS", "TCS01")])
        n = itf.run(fetch_fn=_good_fetch)
        assert n == 6   # 3 bars × 2 symbols
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv").fetchone()[0] == 6

    def test_upsert_same_bars_no_duplicate(self):
        con = _make_db([("INFY", "IT")])
        itf.run(fetch_fn=_good_fetch)
        itf.run(fetch_fn=_good_fetch)
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv").fetchone()[0] == 3

    def test_fetches_symbols_even_without_mcsymbol(self):
        """TechCharts is keyed by the raw NSE ticker, not mcsymbol (verified live against
        MoneyControl -- mcsymbol codes like RI/SBI/HDF01 return {"s":"error"} on this
        endpoint while the raw ticker works) -- a missing/blank mcsymbol must not exclude
        a stock from intraday fetching."""
        con = _make_db([("INFY", "IT"), ("NOCOVER", None)])
        n = itf.run(fetch_fn=_good_fetch)
        assert n == 6   # both INFY and NOCOVER fetched by raw symbol
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv WHERE symbol='NOCOVER'").fetchone()[0] == 3

    def test_fetch_called_with_raw_symbol_not_mcsymbol(self):
        """Regression test for the bug this fetcher shipped with: passing mcsymbol (e.g.
        'RI' for RELIANCE) to TechCharts instead of the raw ticker silently returned zero
        bars for ~98% of the universe every cycle."""
        _make_db([("RELIANCE", "RI")])
        seen = []

        def _capturing_fetch(sym, from_ts, to_ts):
            seen.append(sym)
            return _good_fetch(sym, from_ts, to_ts)

        itf.run(fetch_fn=_capturing_fetch)
        assert seen == ["RELIANCE"]

    def test_skips_symbols_with_no_data(self):
        con = _make_db([("INFY", "IT")])
        n = itf.run(fetch_fn=_empty_fetch)
        assert n == 0

    def test_stores_symbol_and_interval(self):
        con = _make_db([("INFY", "IT")])
        itf.run(fetch_fn=_good_fetch)
        row = con.execute("SELECT symbol, interval FROM intraday_ohlcv LIMIT 1").fetchone()
        assert row[0] == "INFY"
        assert row[1] == "15m"

    def test_returns_total_bar_count(self):
        con = _make_db([("INFY", "IT"), ("TCS", "TCS01"), ("HDFC", "HDF01")])
        n = itf.run(fetch_fn=_good_fetch)
        assert n == 9   # 3 bars × 3 symbols


class TestKnownOpenDaysEndToEnd:
    """run() must consult the DB's own already-recorded bars, not just the current payload, so
    a later cycle whose fetch happens to omit the open bar doesn't overwrite a previously-good
    VWAP with NULL. Regression for the live 2026-08-09 finding (~16% of a session's bars sat
    NULL despite the DB already holding a real 09:15 bar for those symbols)."""

    def _today_session_open(self):
        """run()'s from_ts/to_ts are wall-clock-relative (time.time()), unlike the pure-function
        parse_bars tests above which use a fixed historical epoch -- fixtures here must be
        anchored to real "now" or _known_open_days' window filter would never see them."""
        import time as _time
        now_ist = itf.datetime.datetime.fromtimestamp(_time.time(), tz=itf._IST)
        return int(now_ist.replace(hour=9, minute=15, second=0, microsecond=0).timestamp())

    def _mid_session_fetch(self, mcsymbol, from_ts, to_ts):
        base = self._today_session_open() + 3 * 3600  # 3h in -- no open bar in this payload
        return {
            "t": [base, base + 900],
            "o": [100.0, 100.0], "h": [110.0, 110.0], "l": [90.0, 90.0], "c": [100.0, 100.0],
            "v": [1000, 1000],
        }

    def test_db_known_open_bar_lets_a_later_cycle_still_compute_vwap(self):
        con = _make_db([("INFY", "IT")])
        # Simulate an earlier cycle already having captured today's real 09:15 bar.
        open_dt = itf.datetime.datetime.fromtimestamp(self._today_session_open(), tz=itf._IST)
        open_str = open_dt.strftime("%Y-%m-%dT%H:%M:%S+05:30")
        con.execute(
            "INSERT INTO intraday_ohlcv (symbol, datetime, open, high, low, close, volume, vwap, interval) "
            "VALUES ('INFY', ?, 100.0, 100.0, 100.0, 100.0, 0, NULL, '15m')", (open_str,)
        )
        con.commit()
        itf.run(fetch_fn=self._mid_session_fetch, lookback_days=1)
        rows = con.execute(
            "SELECT vwap FROM intraday_ohlcv WHERE symbol='INFY' AND datetime > ?", (open_str,)
        ).fetchall()
        assert rows, "the mid-session payload's bars must still be written"
        assert all(r[0] is not None for r in rows), (
            "the DB already had a real open bar for this symbol/day -- this cycle's own "
            "payload lacking it must not force VWAP back to NULL"
        )

    def test_without_a_prior_open_bar_vwap_stays_null_as_before(self):
        """Negative control: no known-open hint exists anywhere -- behaviour must be unchanged
        from before this fix (NULL, not a guess)."""
        con = _make_db([("INFY", "IT")])
        itf.run(fetch_fn=self._mid_session_fetch, lookback_days=1)
        rows = con.execute("SELECT vwap FROM intraday_ohlcv WHERE symbol='INFY'").fetchall()
        assert rows and all(r[0] is None for r in rows)


# ── Dual-source (MC + Yahoo) dispatch ───────────────────────────────────────────

class TestDualSourceFetch:
    """run() with fetch_fn=None takes the live dual-source path (_fetch_dual), which
    alternates MC/Yahoo as primary per symbol and falls back to the other source on a
    miss. Network calls are avoided by monkeypatching the module-level _fetch_live /
    _fetch_yahoo functions _fetch_dual actually calls."""

    def test_falls_back_to_yahoo_when_mc_has_no_data(self, monkeypatch):
        con = _make_db([("NOMCDATA", None)])
        monkeypatch.setattr(itf, "_fetch_live", lambda symbol, from_ts, to_ts, countback=500: None)
        monkeypatch.setattr(itf, "_fetch_yahoo", lambda symbol, from_ts, to_ts, countback=500: _good_fetch(symbol, from_ts, to_ts))
        n = itf.run()
        assert n == 3
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv WHERE symbol='NOMCDATA'").fetchone()[0] == 3

    def test_falls_back_to_mc_when_yahoo_has_no_data(self, monkeypatch):
        con = _make_db([("NOYAHOODATA", None)])
        monkeypatch.setattr(itf, "_fetch_live", lambda symbol, from_ts, to_ts, countback=500: _good_fetch(symbol, from_ts, to_ts))
        monkeypatch.setattr(itf, "_fetch_yahoo", lambda symbol, from_ts, to_ts, countback=500: None)
        n = itf.run()
        assert n == 3
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv WHERE symbol='NOYAHOODATA'").fetchone()[0] == 3

    def test_both_sources_empty_counts_as_failed_not_written(self, monkeypatch):
        con = _make_db([("NODATAANYWHERE", None)])
        monkeypatch.setattr(itf, "_fetch_live", lambda *a, **k: None)
        monkeypatch.setattr(itf, "_fetch_yahoo", lambda *a, **k: None)
        n = itf.run()
        assert n == 0
        assert con.execute("SELECT COUNT(*) FROM intraday_ohlcv").fetchone()[0] == 0

    def test_both_sources_get_used_across_the_universe(self, monkeypatch):
        """Regression guard for the load-distribution goal: with both sources healthy,
        neither source should end up handling 100% of the universe."""
        symbols = [(f"SYM{i}", None) for i in range(20)]
        con = _make_db(symbols)
        mc_hits, yahoo_hits = [], []

        def fake_mc(symbol, from_ts, to_ts, countback=500):
            mc_hits.append(symbol)
            return _good_fetch(symbol, from_ts, to_ts)

        def fake_yahoo(symbol, from_ts, to_ts, countback=500):
            yahoo_hits.append(symbol)
            return _good_fetch(symbol, from_ts, to_ts)

        monkeypatch.setattr(itf, "_fetch_live", fake_mc)
        monkeypatch.setattr(itf, "_fetch_yahoo", fake_yahoo)
        itf.run()
        # Each symbol's primary source succeeds immediately, so no fallback calls happen --
        # every symbol hits exactly one of the two sources, split by index parity.
        assert len(mc_hits) + len(yahoo_hits) == 20
        assert len(mc_hits) > 0
        assert len(yahoo_hits) > 0
