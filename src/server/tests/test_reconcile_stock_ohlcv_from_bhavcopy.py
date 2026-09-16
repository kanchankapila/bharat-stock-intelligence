"""Unit tests for reconcile_stock_ohlcv_from_bhavcopy.py (no network -- always runs in CI).

See that file's own docstring and .claude/rules/data-sources.md / AF-20260903-01 for why
this exists: Yahoo's batch quote fetch can silently drop symbols (RELIANCE, live-verified
2026-09-03; PAYTM, a second independent instance found comparing 2026-09-02's tables) from
stock_ohlcv's daily EOD write with no error. This reconciles that day's stock_ohlcv against
the exchange's own bhavcopy (nse_universe_history, already written daily by
nse_bhavcopy_fetcher.py) -- filling anything Yahoo missed and correcting anything it got
wrong, without ever nulling a row that has no bhavcopy counterpart (the recurring
"ELSE NULL erases history" bug class), and without silently widening stock_ohlcv's universe
to bhavcopy's ETFs/micro-caps that aren't in nse_stocks (this platform's canonical master).
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

import reconcile_stock_ohlcv_from_bhavcopy as rec  # noqa: E402


def _make_conn():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY)")
    conn.execute("""CREATE TABLE nse_universe_history (
        date TEXT NOT NULL, symbol TEXT NOT NULL, series TEXT,
        prev_close REAL, open REAL, high REAL, low REAL, close REAL,
        avg_price REAL, volume REAL, turnover_lacs REAL, num_trades REAL,
        deliv_qty REAL, deliv_pct REAL,
        PRIMARY KEY (date, symbol, series)
    )""")
    conn.execute("""CREATE TABLE stock_ohlcv (
        symbol TEXT NOT NULL, date DATE NOT NULL,
        open REAL, high REAL, low REAL, close REAL, volume BIGINT,
        is_suspect BIGINT, adjustment_basis TEXT, suspect_reason TEXT,
        PRIMARY KEY (symbol, date)
    )""")
    conn.commit()
    return conn


def _seed_master(conn, *symbols):
    for s in symbols:
        conn.execute("INSERT INTO nse_stocks (symbol) VALUES (?)", (s,))
    conn.commit()


def _seed_bhavcopy(conn, date, symbol, o, h, l, c, v, series='EQ'):
    conn.execute(
        "INSERT INTO nse_universe_history (date, symbol, series, open, high, low, close, volume) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (date, symbol, series, o, h, l, c, v),
    )
    conn.commit()


class TestReconcileFillsMissingSymbol:
    def test_symbol_missing_from_stock_ohlcv_gets_filled_from_bhavcopy(self):
        """The exact RELIANCE case: Yahoo's batch fetch dropped it, bhavcopy has it."""
        conn = _make_conn()
        _seed_master(conn, 'RELIANCE')
        _seed_bhavcopy(conn, '2026-09-03', 'RELIANCE', 1298.0, 1321.9, 1293.1, 1313.1, 13497841)

        result = rec.reconcile(conn, trade_date='2026-09-03')

        assert result['written'] == 1
        row = dict(conn.execute(
            "SELECT * FROM stock_ohlcv WHERE symbol='RELIANCE' AND date::text='2026-09-03'"
        ).fetchone())
        assert row['close'] == 1313.1
        assert row['volume'] == 13497841
        assert row['adjustment_basis'] == 'nse_bhavcopy_raw'


class TestReconcileCorrectsExistingSymbol:
    def test_wrong_yahoo_value_is_overwritten_by_bhavcopy(self):
        """A symbol Yahoo DID write, but with a value that drifted from the exchange's own
        print -- reconcile(overwrite=True) (the default) must correct it."""
        conn = _make_conn()
        _seed_master(conn, 'INFY')
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
            "VALUES ('INFY', '2026-09-03', 1500.0, 1510.0, 1495.0, 1505.0, 5000000)"
        )
        conn.commit()
        _seed_bhavcopy(conn, '2026-09-03', 'INFY', 1499.5, 1511.2, 1494.0, 1508.75, 5123456)

        result = rec.reconcile(conn, trade_date='2026-09-03')

        assert result['written'] == 1
        row = dict(conn.execute(
            "SELECT * FROM stock_ohlcv WHERE symbol='INFY' AND date::text='2026-09-03'"
        ).fetchone())
        assert row['close'] == 1508.75
        assert row['volume'] == 5123456

    def test_overwrite_false_never_touches_an_existing_row(self):
        conn = _make_conn()
        _seed_master(conn, 'INFY')
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
            "VALUES ('INFY', '2026-09-03', 1500.0, 1510.0, 1495.0, 1505.0, 5000000)"
        )
        conn.commit()
        _seed_bhavcopy(conn, '2026-09-03', 'INFY', 1499.5, 1511.2, 1494.0, 1508.75, 5123456)

        rec.reconcile(conn, trade_date='2026-09-03', overwrite=False)

        row = dict(conn.execute(
            "SELECT * FROM stock_ohlcv WHERE symbol='INFY' AND date::text='2026-09-03'"
        ).fetchone())
        assert row['close'] == 1505.0, "overwrite=False must leave the existing row untouched"


class TestReconcileSeriesFilter:
    def test_non_eq_series_never_reaches_stock_ohlcv(self):
        """nse_universe_history carries SM/BE/ST/BZ series too -- stock_ohlcv's canonical
        universe is EQ-only (matching stocklist.ts), so a BE (trade-to-trade) print must
        never land here."""
        conn = _make_conn()
        _seed_master(conn, 'SOMEBE')
        _seed_bhavcopy(conn, '2026-09-03', 'SOMEBE', 100.0, 105.0, 99.0, 102.0, 1000, series='BE')

        result = rec.reconcile(conn, trade_date='2026-09-03')

        assert result['written'] == 0
        row = conn.execute("SELECT * FROM stock_ohlcv WHERE symbol='SOMEBE'").fetchone()
        assert row is None


class TestReconcileUniverseScoping:
    def test_eq_series_symbol_outside_nse_stocks_is_excluded(self):
        """Live-checked 2026-09-03 (date 2026-09-02): bhavcopy's EQ series alone carries
        2,646 symbols against stock_ohlcv's 2,436 -- but 209 of that 210-row gap are ETFs
        (ABSLBANETF, AONEGOLD, ...) and micro-caps outside nse_stocks entirely. An EQ-series
        bhavcopy row for a symbol nse_stocks doesn't track must not silently widen
        stock_ohlcv's universe -- only the JOIN against nse_stocks makes this table's
        297-line-blast-radius-safe."""
        conn = _make_conn()
        # deliberately NOT seeded into nse_stocks -- an ETF bhavcopy carries as series='EQ' too
        _seed_bhavcopy(conn, '2026-09-03', 'SOMEETF', 50.0, 51.0, 49.5, 50.5, 200000)

        result = rec.reconcile(conn, trade_date='2026-09-03')

        assert result['written'] == 0
        row = conn.execute("SELECT * FROM stock_ohlcv WHERE symbol='SOMEETF'").fetchone()
        assert row is None


class TestReconcileNoBhavcopyIsCleanNoop:
    def test_no_rows_for_date_does_not_touch_stock_ohlcv(self):
        """The 'ELSE NULL erases history' anti-pattern (recurring-bugs.md): a day with no
        published bhavcopy (holiday, upstream outage) must be a clean no-op, never a wipe."""
        conn = _make_conn()
        _seed_master(conn, 'INFY')
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
            "VALUES ('INFY', '2026-09-03', 1500.0, 1510.0, 1495.0, 1505.0, 5000000)"
        )
        conn.commit()

        result = rec.reconcile(conn, trade_date='2026-09-03')

        assert result['written'] == 0
        assert result.get('skipped')
        row = dict(conn.execute(
            "SELECT * FROM stock_ohlcv WHERE symbol='INFY' AND date::text='2026-09-03'"
        ).fetchone())
        assert row['close'] == 1505.0, "a day with no bhavcopy rows must not touch existing data"


class TestReconcileDefaultsToLatestDate:
    def test_no_trade_date_arg_resolves_to_max_bhavcopy_date(self):
        conn = _make_conn()
        _seed_master(conn, 'INFY')
        _seed_bhavcopy(conn, '2026-09-01', 'INFY', 1490.0, 1500.0, 1485.0, 1495.0, 4000000)
        _seed_bhavcopy(conn, '2026-09-02', 'INFY', 1495.0, 1505.0, 1490.0, 1500.0, 4200000)

        result = rec.reconcile(conn)

        assert result['trade_date'] == '2026-09-02'
        row = dict(conn.execute(
            "SELECT * FROM stock_ohlcv WHERE symbol='INFY' AND date::text='2026-09-02'"
        ).fetchone())
        assert row['close'] == 1500.0
