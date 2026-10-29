"""Sub-project B.4: AF-20261008-13 history-repair scripts (scripts/repair/).

Each script is dry-run by default (prints per-table counts, changes nothing) and refuses
`--apply` without `--dump-path` naming an existing, fresh pg_dump file. Run here only against a
throwaway schema (pg_conn); never against production from a test.
"""
import importlib.util
import os

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def _load(name):
    path = os.path.join(REPO, 'scripts', 'repair', f'{name}.py')
    spec = importlib.util.spec_from_file_location(f'repair_{name}', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def dump(tmp_path):
    p = tmp_path / 'tables.dump'
    p.write_bytes(b'PGDMP\x01\x0e\x00' + b'\x00' * 64)
    return str(p)


def _q(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()


# ── (c) phantom non-trading-day rows ─────────────────────────────────────────

def _seed_phantom(conn):
    conn.execute("CREATE TABLE market_holidays (date DATE, exchange TEXT, description TEXT)")
    conn.execute("INSERT INTO market_holidays VALUES ('2026-10-02', 'NSE', 'Gandhi Jayanti')")
    for t in ('stock_futures_oi_history', 'market_breadth'):
        conn.execute(f"CREATE TABLE {t} (symbol TEXT, date DATE, v REAL)")
        for d in ('2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05'):
            conn.execute(f"INSERT INTO {t} VALUES ('X', ?, 1.0)", (d,))
    conn.commit()


def _counts(conn):
    return {t: _q(conn, f"SELECT count(*) FROM {t}")[0][0]
            for t in ('stock_futures_oi_history', 'market_breadth')}


def test_phantom_dry_run_changes_nothing(pg_conn, capsys):
    m = _load('repair_phantom_session_rows')
    _seed_phantom(pg_conn)
    assert m.main([], conn=pg_conn) == 0
    out = capsys.readouterr().out
    assert 'stock_futures_oi_history' in out and 'would delete 2' in out
    assert 'so_option_chain' in out and 'absent' in out
    assert _counts(pg_conn) == {'stock_futures_oi_history': 4, 'market_breadth': 4}


@pytest.mark.parametrize('extra', [[], ['--dump-path', 'Z:/no/such/file.dump'], 'notdump'])
def test_phantom_apply_refuses_without_valid_dump(pg_conn, tmp_path, extra):
    m = _load('repair_phantom_session_rows')
    _seed_phantom(pg_conn)
    if extra == 'notdump':
        p = tmp_path / 'x.txt'
        p.write_text('hello')
        extra = ['--dump-path', str(p)]
    assert m.main(['--apply'] + extra, conn=pg_conn) == 2
    assert _counts(pg_conn) == {'stock_futures_oi_history': 4, 'market_breadth': 4}


def test_phantom_apply_deletes_only_closed_days(pg_conn, dump):
    m = _load('repair_phantom_session_rows')
    _seed_phantom(pg_conn)
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    for t in ('stock_futures_oi_history', 'market_breadth'):
        assert [str(r[0]) for r in _q(pg_conn, f"SELECT date FROM {t} ORDER BY date")] == \
            ['2026-10-01', '2026-10-05']


# ── (b) eps_surprise_history on ambiguous / misattributed mcsymbols ──────────

def _seed_eps(conn):
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT, mcsymbol TEXT, status TEXT DEFAULT 'ACTIVE')")
    conn.executemany("INSERT INTO nse_stocks VALUES (?,?)",
                     [('KOTAKBANK', 'KMF'), ('MAHINDRA', 'KMF'), ('INFY', 'INF01')])
    conn.execute("CREATE TABLE eps_surprise_history (scid TEXT, symbol TEXT, quarter TEXT, "
                 "eps_surprise REAL, PRIMARY KEY (scid, quarter))")
    conn.executemany("INSERT INTO eps_surprise_history VALUES (?,?,?,1.0)",
                     [('KMF', 'MAHINDRA', 'Q1'), ('INF01', 'WRONG', 'Q1'), ('INF01', 'INFY', 'Q2')])
    conn.commit()


def test_eps_dry_run_then_apply(pg_conn, dump, capsys):
    m = _load('repair_eps_surprise_mcsymbol')
    _seed_eps(pg_conn)
    before = _q(pg_conn, "SELECT scid, symbol, quarter FROM eps_surprise_history ORDER BY 1, 3")
    assert m.main([], conn=pg_conn) == 0
    out = capsys.readouterr().out
    assert 'would delete 1' in out and 'would reattribute 1' in out
    assert _q(pg_conn, "SELECT scid, symbol, quarter FROM eps_surprise_history ORDER BY 1, 3") == before
    assert m.main(['--apply'], conn=pg_conn) == 2
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    assert [tuple(r) for r in _q(pg_conn, "SELECT scid, symbol, quarter FROM eps_surprise_history ORDER BY 1, 3")] == \
        [('INF01', 'INFY', 'Q1'), ('INF01', 'INFY', 'Q2')]


# ── (a) point-in-time countdown / shocker recompute ──────────────────────────

def _seed_clocks(conn):
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT, mcsymbol TEXT, status TEXT DEFAULT 'ACTIVE')")
    conn.executemany("INSERT INTO nse_stocks VALUES (?,?)", [('INFY', 'INF01'), ('TCS', 'TCS1')])
    conn.execute("CREATE TABLE stock_earnings_dates (scid TEXT, result_date DATE, fetched_at TEXT)")
    conn.executemany("INSERT INTO stock_earnings_dates VALUES (?,?,?)", [
        ('INF01', '2026-08-10', '2026-08-03T10:00:00'),   # known on 08-05 -> 5 days
        ('TCS1', '2026-08-20', '2026-08-15T10:00:00'),    # last seen AFTER 08-05 -> unknowable
    ])
    conn.execute("CREATE TABLE mc_price_shockers (scid TEXT, gain_since_result REAL, fetched_at TEXT)")
    conn.execute("INSERT INTO mc_price_shockers VALUES ('INF01', 7.0, '2026-08-05T12:00:00')")
    conn.execute("CREATE TABLE technical_signals (symbol TEXT, date DATE, days_to_next_results BIGINT, "
                 "earnings_shocker_flag BIGINT, earnings_shocker_gain DOUBLE PRECISION)")
    conn.executemany("INSERT INTO technical_signals VALUES (?,?,?,?,?)", [
        ('INFY', '2026-08-05', 99, 0, None),     # forward-filled countdown
        ('TCS', '2026-08-05', 1, 1, 3.0),        # smeared flag
        ('INFY', '2026-10-08', 2, 1, 1.0),       # outside --until: never touched
    ])
    conn.commit()


def _ts(conn):
    return [tuple(r) for r in _q(conn, "SELECT symbol, date::text, days_to_next_results, "
                                       "earnings_shocker_flag, earnings_shocker_gain "
                                       "FROM technical_signals ORDER BY date, symbol")]


def test_event_clocks_dry_run_then_apply(pg_conn, dump, capsys):
    m = _load('repair_event_clocks')
    _seed_clocks(pg_conn)
    before = _ts(pg_conn)
    args = ['--since', '2026-08-05', '--until', '2026-08-05']
    assert m.main(args, conn=pg_conn) == 0
    out = capsys.readouterr().out
    assert 'days_to_next_results: would change 2' in out
    assert 'earnings_shocker: would change 2' in out
    assert _ts(pg_conn) == before
    assert m.main(args + ['--apply'], conn=pg_conn) == 2
    assert m.main(args + ['--apply', '--dump-path', dump], conn=pg_conn) == 0
    assert _ts(pg_conn) == [
        ('INFY', '2026-08-05', 5, 1, 7.0),
        ('TCS', '2026-08-05', None, None, None),
        ('INFY', '2026-10-08', 2, 1, 1.0),
    ]


# ── (d) market_regimes.backfilled, only if the column exists ─────────────────

def _seed_regimes(conn, with_col):
    extra = ', backfilled BOOLEAN' if with_col else ''
    conn.execute(f"CREATE TABLE market_regimes (date TEXT PRIMARY KEY, regime TEXT{extra})")
    conn.executemany("INSERT INTO market_regimes (date, regime) VALUES (?, 'BULL')",
                     [('2026-08-01',), ('2026-08-12',)])
    conn.commit()


def test_regime_backfilled_absent_column_is_noop(pg_conn, dump, capsys):
    m = _load('repair_regime_backfilled')
    _seed_regimes(pg_conn, False)
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    assert 'absent' in capsys.readouterr().out


def test_regime_backfilled_dry_run_then_apply(pg_conn, dump, capsys):
    m = _load('repair_regime_backfilled')
    _seed_regimes(pg_conn, True)
    assert m.main([], conn=pg_conn) == 0
    assert 'would update 1' in capsys.readouterr().out
    assert _q(pg_conn, "SELECT count(*) FROM market_regimes WHERE backfilled") == [(0,)]
    assert m.main(['--apply'], conn=pg_conn) == 2
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    assert [tuple(r) for r in _q(pg_conn, "SELECT date, backfilled FROM market_regimes ORDER BY date")] == \
        [('2026-08-01', True), ('2026-08-12', None)]


def test_regime_backfilled_is_a_persistent_schema_contract():
    """The repair must not remain dormant merely because production lacks its column."""
    from pathlib import Path

    schema = (Path(REPO) / 'db' / 'schema.postgres.sql').read_text(encoding='utf-8')
    migration = (Path(REPO) / 'migrations' /
                 '20261011124500_market-regimes-backfilled.sql').read_text(encoding='utf-8')

    market_regimes = schema.split('CREATE TABLE IF NOT EXISTS "market_regimes"', 1)[1].split(');', 1)[0]
    assert '"backfilled" BOOLEAN NOT NULL DEFAULT false' in market_regimes
    assert 'ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT FALSE' in migration
    assert "date < DATE '2026-08-10'" in migration


def test_event_clock_ctes_are_materialized():
    """A non-materialized CTE referenced from a correlated subquery is re-run per technical_signals row
    (the live dry-run did not finish in 12 minutes; MATERIALIZED makes the one-day count take 2 s)."""
    import importlib.util
    import pathlib
    p = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "repair" / "repair_event_clocks.py"
    text = p.read_text(encoding="utf-8")
    assert "WITH k AS MATERIALIZED" in text and "pit AS MATERIALIZED" in text and "WITH s AS MATERIALIZED" in text


# ── ghost bars: absent from a complete official bhavcopy ────────────────────

def _seed_ghosts(conn):
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY)")
    conn.execute("CREATE TABLE nse_universe_history (date DATE, symbol TEXT, series TEXT, close REAL, "
                 "PRIMARY KEY (date, symbol, series))")
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open REAL, high REAL, low REAL, "
                 "close REAL, volume BIGINT, is_suspect BIGINT, suspect_reason TEXT, PRIMARY KEY (symbol, date))")
    conn.execute("INSERT INTO nse_stocks VALUES ('GHOST'), ('ALIAS'), ('LIVE')")
    for d in ('2026-10-12', '2026-10-13', '2026-10-14'):
        conn.execute("INSERT INTO nse_universe_history SELECT ?, 'F' || g, 'EQ', 1 "
                     "FROM generate_series(1, 1500) g", (d,))
        conn.execute("INSERT INTO nse_universe_history VALUES (?, 'LIVE', 'EQ', 5)", (d,))
        for s in ('GHOST', 'ALIAS', 'LIVE'):
            conn.execute("INSERT INTO stock_ohlcv VALUES (?, ?, 5, 6, 4, 5, 100, 0, NULL)", (s, d))
    conn.execute("INSERT INTO nse_universe_history VALUES ('2026-10-12', 'GHOST', 'EQ', 5)")
    conn.commit()


def _flags(conn):
    return [(r[0], str(r[1]), r[2]) for r in _q(
        conn, "SELECT symbol, date, suspect_reason FROM stock_ohlcv WHERE is_suspect = 1 ORDER BY 1, 2")]


def test_ghost_bars_dry_run_then_apply_then_idempotent(pg_conn, dump, capsys):
    m = _load('flag_ghost_bars')
    _seed_ghosts(pg_conn)
    assert m.main([], conn=pg_conn) == 0
    out = capsys.readouterr().out
    assert '2026-10-13: 1 ghost bar(s), 1 identical to the previous bar: GHOST' in out
    assert 'would flag 1' in out and 'ALIAS' not in out
    assert _flags(pg_conn) == []

    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    reason = m.GHOST_REASON
    assert _flags(pg_conn) == [('GHOST', '2026-10-13', reason), ('GHOST', '2026-10-14', reason)]

    capsys.readouterr()
    assert m.main([], conn=pg_conn) == 0
    assert 'would flag' not in capsys.readouterr().out


def test_ghost_bars_apply_refuses_without_dump(pg_conn):
    m = _load('flag_ghost_bars')
    _seed_ghosts(pg_conn)
    assert m.main(['--apply'], conn=pg_conn) == 2
    assert _flags(pg_conn) == []
