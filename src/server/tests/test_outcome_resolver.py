import sqlite3, sys, os, datetime
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Signals must be older than the resolver's 30-day cutoff (ts.date <= today-30).
SIGNAL_DATE = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
EXIT_DATE   = (datetime.date.today() - datetime.timedelta(days=39)).isoformat()  # signal + 1d horizon


def make_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, cmp REAL, signal_score INTEGER,
            signals_json TEXT, stop_loss TEXT, time_horizon TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
    """)
    return conn


def seed_flat_history(conn, symbol, price=100.0, n=15):
    """Flat daily closes before the signal => daily vol 0 => vol threshold clamps to its
    0.5% floor, making outcome classification deterministic."""
    d = datetime.date.fromisoformat(SIGNAL_DATE)
    for i in range(n, 0, -1):
        day = (d - datetime.timedelta(days=i)).isoformat()
        conn.execute("INSERT OR IGNORE INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)",
                     (symbol, day, price, price, price, price, 100000))


def add_signal(conn, symbol, *, stop_loss=None, score=6):
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, cmp, signal_score, signals_json, stop_loss, time_horizon) "
        "VALUES (?,?,100.0,?,'[]',?,'1 day')",
        (symbol, SIGNAL_DATE, score, stop_loss),
    )


def add_exit_bar(conn, symbol, *, open_=100.0, high=100.0, low=100.0, close=100.0):
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)",
                 (symbol, EXIT_DATE, open_, high, low, close, 100000))


def resolve(conn):
    from outcome_resolver import resolve_outcomes
    return resolve_outcomes(conn, horizon_days=1, dry_run=False)


def get_row(conn, symbol):
    return conn.execute(
        "SELECT outcome, return_pct FROM signal_outcomes WHERE symbol=?", (symbol,)
    ).fetchone()


# ─── baseline outcome labels (large, unambiguous moves) ─────────────────────────

def test_win_outcome():
    conn = make_db()
    seed_flat_history(conn, 'RELIANCE')
    add_signal(conn, 'RELIANCE')
    add_exit_bar(conn, 'RELIANCE', open_=100, high=111, low=100, close=110)  # +10%
    conn.commit()
    assert resolve(conn)['resolved'] >= 1
    assert get_row(conn, 'RELIANCE')[0] == 'WIN'


def test_loss_outcome():
    conn = make_db()
    seed_flat_history(conn, 'HDFCBANK')
    add_signal(conn, 'HDFCBANK')
    add_exit_bar(conn, 'HDFCBANK', open_=100, high=100, low=89, close=90)  # -10%
    conn.commit()
    assert resolve(conn)['resolved'] >= 1
    assert get_row(conn, 'HDFCBANK')[0] == 'LOSS'


def test_stop_loss_outcome():
    conn = make_db()
    seed_flat_history(conn, 'TCS')
    add_signal(conn, 'TCS', stop_loss='95.0')
    add_exit_bar(conn, 'TCS', open_=100, high=100, low=94, close=97)  # intraday low breaches 95
    conn.commit()
    assert resolve(conn)['resolved'] >= 1
    assert get_row(conn, 'TCS')[0] == 'STOP_LOSS'


def test_neutral_outcome():
    conn = make_db()
    seed_flat_history(conn, 'ICICIBANK')
    add_signal(conn, 'ICICIBANK')
    add_exit_bar(conn, 'ICICIBANK', open_=100, high=101, low=99, close=100.3)  # +0.3% < 0.5% band
    conn.commit()
    assert resolve(conn)['resolved'] >= 1
    assert get_row(conn, 'ICICIBANK')[0] == 'NEUTRAL'


def test_pending_when_no_ohlcv():
    conn = make_db()
    seed_flat_history(conn, 'WIPRO')
    add_signal(conn, 'WIPRO')  # no exit bar
    conn.commit()
    assert resolve(conn)['resolved'] == 0
    assert get_row(conn, 'WIPRO')[0] == 'PENDING'


def test_resolve_outcomes_excludes_suspect_bars():
    conn = make_db()
    seed_flat_history(conn, 'SUSP')
    add_signal(conn, 'SUSP')
    # the only post-signal bar is a flagged bad print that would otherwise be a +100% WIN
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume,is_suspect) "
                 "VALUES ('SUSP',?,100,200,100,200,100000,1)", (EXIT_DATE,))
    conn.commit()
    resolve(conn)
    row = get_row(conn, 'SUSP')
    assert row is not None
    assert row[0] == 'PENDING'   # nothing clean to resolve against


def test_volatility_threshold_ignores_suspect_bars():
    from outcome_resolver import get_volatility_threshold
    conn = make_db()
    base = datetime.date.fromisoformat(SIGNAL_DATE)
    for i in range(12, 0, -1):
        d = (base - datetime.timedelta(days=i)).isoformat()
        if i == 6:   # a suspect spike that would blow up the vol estimate if counted
            conn.execute("INSERT INTO stock_ohlcv (symbol,date,close,is_suspect) VALUES ('V',?,5000,1)", (d,))
        else:
            conn.execute("INSERT INTO stock_ohlcv (symbol,date,close,is_suspect) VALUES ('V',?,100,0)", (d,))
    conn.commit()
    thr = get_volatility_threshold(conn, 'V', SIGNAL_DATE, 5)
    assert thr == pytest.approx(0.5, abs=0.01)   # flat history -> floor; spike excluded


def test_dry_run_writes_nothing():
    conn = make_db()
    seed_flat_history(conn, 'INFY')
    add_signal(conn, 'INFY')
    add_exit_bar(conn, 'INFY', open_=100, high=112, low=108, close=111)
    conn.commit()
    from outcome_resolver import resolve_outcomes
    resolve_outcomes(conn, horizon_days=1, dry_run=True)
    assert conn.execute("SELECT COUNT(*) FROM signal_outcomes").fetchone()[0] == 0


# ─── net-of-cost (#3): win rate must be measured after round-trip transaction costs ──

def test_return_pct_is_net_of_round_trip_costs():
    from outcome_resolver import ROUND_TRIP_COST_PCT
    conn = make_db()
    seed_flat_history(conn, 'RELIANCE')
    add_signal(conn, 'RELIANCE')
    add_exit_bar(conn, 'RELIANCE', open_=100, high=111, low=100, close=110)  # +10% gross
    conn.commit()
    resolve(conn)
    _, return_pct = get_row(conn, 'RELIANCE')
    assert return_pct == pytest.approx(10.0 - ROUND_TRIP_COST_PCT, abs=0.01)


def test_marginal_gross_winner_flips_to_neutral_after_costs():
    # +0.6% gross clears the 0.5% vol threshold (gross => WIN), but net of a ~0.3% round
    # trip it falls back inside the band => NEUTRAL. This is the false-positive the gross
    # measurement was minting.
    conn = make_db()
    seed_flat_history(conn, 'MARGINAL')
    add_signal(conn, 'MARGINAL')
    add_exit_bar(conn, 'MARGINAL', open_=100, high=101, low=100, close=100.6)
    conn.commit()
    resolve(conn)
    outcome, return_pct = get_row(conn, 'MARGINAL')
    assert outcome == 'NEUTRAL'
    assert return_pct < 0.5


def test_stop_loss_return_also_net_of_costs():
    from outcome_resolver import ROUND_TRIP_COST_PCT
    conn = make_db()
    seed_flat_history(conn, 'TCS')
    add_signal(conn, 'TCS', stop_loss='95.0')
    add_exit_bar(conn, 'TCS', open_=100, high=100, low=94, close=97)
    conn.commit()
    resolve(conn)
    _, return_pct = get_row(conn, 'TCS')
    assert return_pct == pytest.approx(-5.0 - ROUND_TRIP_COST_PCT, abs=0.01)


# ─── unified resolver exit policy (#2): target capture + trailing instead of horizon-close ──

def make_unified_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE unified_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, signal_date TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL, signal_source TEXT,
            confidence_score REAL, status TEXT DEFAULT 'ACTIVE'
        );
        CREATE TABLE unified_signal_outcomes (
            unified_signal_id INTEGER, signal_source TEXT, symbol TEXT, signal_date TEXT,
            horizon_days INTEGER, entry_price REAL, entry_time TEXT, check_date TEXT,
            exit_price REAL, outcome TEXT, return_pct REAL, exit_reason TEXT, computed_at TEXT,
            PRIMARY KEY (unified_signal_id, horizon_days)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL,
            volume INTEGER, is_suspect INTEGER DEFAULT 0, PRIMARY KEY (symbol, date)
        );
    """)
    return conn


def test_unified_target_capture_beats_faded_horizon_close():
    from outcome_resolver import resolve_unified_outcomes
    conn = make_unified_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    base = datetime.date.fromisoformat(sig_date)
    # flat history before signal -> ATR ~0 (trailing disabled, isolates target capture)
    for i in range(15, 0, -1):
        d = (base - datetime.timedelta(days=i)).isoformat()
        conn.execute("INSERT OR IGNORE INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,100,100,100,100,100000)", ('ZED', d))
    conn.execute("INSERT INTO unified_signals (symbol, signal_date, entry_price, target_price, stop_loss, signal_source, confidence_score) "
                 "VALUES ('ZED', ?, 100, 105, 97, 'AI', 70)", (sig_date,))
    # day+1 spikes through the 105 target, then fades back to ~100 by horizon (5d)
    bars = [
        (1, 100, 106, 100, 104),   # entry open 100, high 106 captures target
        (2, 102, 103, 100, 101),
        (3, 101, 102,  99, 100),
        (4, 100, 101,  99, 100),
        (5, 100, 100,  99, 100),   # horizon close ~100
    ]
    for off, o, h, l, c in bars:
        d = (base + datetime.timedelta(days=off)).isoformat()
        conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,100000)", ('ZED', d, o, h, l, c))
    conn.commit()

    resolve_unified_outcomes(conn, horizon_days=5, dry_run=False)
    row = conn.execute(
        "SELECT outcome, return_pct, exit_reason FROM unified_signal_outcomes WHERE symbol='ZED'"
    ).fetchone()
    assert row is not None
    # Old logic booked the faded horizon close (~0% -> NEUTRAL). New: 50% at +5%, rest to
    # time-exit ~0% => ~2.5% gross, ~2.2% net => a WIN.
    assert row[1] == pytest.approx(2.5 - 0.30, abs=0.05)
    assert row[0] == 'WIN'
    assert row[2] in ('TIME_EXIT_PARTIAL', 'TRAILING_STOP', 'TARGET')


def make_reclog_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE recommendation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, signal_date TEXT,
            entry_price REAL, stop_loss REAL, target_1 REAL, horizon_days INTEGER,
            outcome TEXT, actual_exit_price REAL, actual_return_pct REAL,
            status TEXT, resolved_at TEXT
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL,
            volume INTEGER, is_suspect INTEGER DEFAULT 0, PRIMARY KEY (symbol, date)
        );
    """)
    return conn


def test_reclog_target_capture_beats_faded_horizon_close():
    from outcome_resolver import resolve_recommendation_log
    conn = make_reclog_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    base = datetime.date.fromisoformat(sig_date)
    for i in range(15, 0, -1):  # flat history -> ATR ~0, isolates target capture
        d = (base - datetime.timedelta(days=i)).isoformat()
        conn.execute("INSERT OR IGNORE INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES ('REC1',?,100,100,100,100,100000)", (d,))
    conn.execute("INSERT INTO recommendation_log (symbol, signal_date, entry_price, stop_loss, target_1, horizon_days, outcome) "
                 "VALUES ('REC1', ?, 100, 97, 105, 5, 'PENDING')", (sig_date,))
    bars = [(1, 100, 106, 100, 104), (2, 102, 103, 100, 101), (3, 101, 102, 99, 100),
            (4, 100, 101, 99, 100), (5, 100, 100, 99, 100)]  # spikes through 105 then fades to ~100
    for off, o, h, l, c in bars:
        d = (base + datetime.timedelta(days=off)).isoformat()
        conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES ('REC1',?,?,?,?,?,100000)", (d, o, h, l, c))
    conn.commit()

    resolve_recommendation_log(conn, horizon_days=5, dry_run=False)
    row = conn.execute("SELECT outcome, actual_return_pct FROM recommendation_log WHERE symbol='REC1'").fetchone()
    assert row is not None
    # old logic booked the faded close (~0% -> NEUTRAL); new captures 50% at +5% -> ~2.2% net WIN
    assert row[1] == pytest.approx(2.5 - 0.30, abs=0.05)
    assert row[0] == 'WIN'


def test_unified_resolution_excludes_suspect_bars():
    from outcome_resolver import resolve_unified_outcomes
    conn = make_unified_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    base = datetime.date.fromisoformat(sig_date)
    for i in range(15, 0, -1):
        d = (base - datetime.timedelta(days=i)).isoformat()
        conn.execute("INSERT OR IGNORE INTO stock_ohlcv (symbol,date,open,high,low,close,volume) "
                     "VALUES ('ZED2',?,100,100,100,100,100000)", (d,))
    conn.execute("INSERT INTO unified_signals (symbol, signal_date, entry_price, target_price, stop_loss, signal_source, confidence_score) "
                 "VALUES ('ZED2', ?, 100, 130, 80, 'AI', 70)", (sig_date,))
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES ('ZED2',?,100,101,99,100,100000)",
                 ((base + datetime.timedelta(days=1)).isoformat(),))
    # a suspect 0.00 bad print inside the window — its low would trip the stop if not excluded
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume,is_suspect) VALUES ('ZED2',?,0,0,0,0,100000,1)",
                 ((base + datetime.timedelta(days=3)).isoformat(),))
    conn.commit()

    resolve_unified_outcomes(conn, horizon_days=5, dry_run=False)
    row = conn.execute("SELECT outcome, return_pct FROM unified_signal_outcomes WHERE symbol='ZED2'").fetchone()
    assert row is not None
    assert row[0] != 'STOP_LOSS'    # the 0.00 print must not trigger the stop
    assert row[1] > -10


# ─── multi-horizon regression tests (the starvation bugs) ───────────────────────
#
# Bug 1 (resolve_outcomes): the pending NOT EXISTS matched any resolved horizon,
#   so h1 resolution caused h5/h15 passes to find nothing pending.
# Bug 2 (resolve_unified_outcomes): setting status='COMPLETED' after h1 caused
#   h5/h15 passes to skip the same signal (pending query excluded COMPLETED rows).

def make_multi_horizon_db():
    """Schema for both bugs: technical_signals + signal_outcomes + unified tables."""
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, cmp REAL, signal_score INTEGER,
            signals_json TEXT, stop_loss TEXT, time_horizon TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
        CREATE TABLE unified_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, signal_date TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL, signal_source TEXT,
            confidence_score REAL, status TEXT DEFAULT 'ACTIVE'
        );
        CREATE TABLE unified_signal_outcomes (
            unified_signal_id INTEGER, signal_source TEXT, symbol TEXT, signal_date TEXT,
            horizon_days INTEGER, entry_price REAL, entry_time TEXT, check_date TEXT,
            exit_price REAL, outcome TEXT, return_pct REAL, exit_reason TEXT, computed_at TEXT,
            PRIMARY KEY (unified_signal_id, horizon_days)
        );
    """)
    return conn


def _seed_ohlcv(conn, symbol, sig_date_str, n_pre=15, price=100.0, exit_price=110.0, n_post=20):
    """Seed flat pre-signal history and rising post-signal bars for n_post days."""
    base = datetime.date.fromisoformat(sig_date_str)
    for i in range(n_pre, 0, -1):
        d = (base - datetime.timedelta(days=i)).isoformat()
        conn.execute(
            "INSERT OR IGNORE INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,100000)",
            (symbol, d, price, price, price, price)
        )
    for i in range(1, n_post + 1):
        d = (base + datetime.timedelta(days=i)).isoformat()
        conn.execute(
            "INSERT OR IGNORE INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,100000)",
            (symbol, d, exit_price, exit_price, exit_price, exit_price)
        )


def test_resolve_outcomes_resolves_signal_with_null_cmp_using_next_day_open():
    """Signals with NULL cmp must resolve by using next-trading-day open as entry price."""
    from outcome_resolver import resolve_outcomes
    conn = make_multi_horizon_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    # Insert signal with NULL cmp (as happens when technical scanner doesn't capture live price)
    conn.execute(
        "INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
        "VALUES ('NULLCMP',?,NULL,6,'[]',NULL,NULL)",
        (sig_date,)
    )
    _seed_ohlcv(conn, 'NULLCMP', sig_date, price=100.0, exit_price=110.0, n_post=5)
    conn.commit()

    result = resolve_outcomes(conn, horizon_days=1)
    assert result['resolved'] >= 1, "signal with null cmp must still resolve via next-day open"
    row = conn.execute(
        "SELECT outcome FROM signal_outcomes WHERE symbol='NULLCMP' AND horizon_days=1"
    ).fetchone()
    assert row is not None
    assert row[0] in ('WIN', 'LOSS', 'NEUTRAL', 'STOP_LOSS')


def test_resolve_outcomes_produces_all_three_horizons_independently():
    """Bug 1: resolving h1 must not prevent h5 and h15 from being produced for the same signal."""
    from outcome_resolver import resolve_outcomes
    conn = make_multi_horizon_db()
    # Signal old enough for all three horizons (1/5/15) to have elapsed
    sig_date = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    conn.execute(
        "INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
        "VALUES ('MULTI1',?,100.0,6,'[]',NULL,NULL)",
        (sig_date,)
    )
    _seed_ohlcv(conn, 'MULTI1', sig_date, exit_price=110.0, n_post=20)
    conn.commit()

    resolve_outcomes(conn, horizon_days=1)
    resolve_outcomes(conn, horizon_days=5)
    resolve_outcomes(conn, horizon_days=15)

    rows = conn.execute(
        "SELECT horizon_days, outcome FROM signal_outcomes WHERE symbol='MULTI1' ORDER BY horizon_days"
    ).fetchall()
    horizons_resolved = {r[0] for r in rows if r[1] not in ('PENDING', None)}
    assert 1 in horizons_resolved, "h1 outcome missing"
    assert 5 in horizons_resolved, "h5 outcome missing — Bug 1: h1 consumed the signal"
    assert 15 in horizons_resolved, "h15 outcome missing — Bug 1: h1 consumed the signal"


def test_resolve_unified_outcomes_produces_all_horizons_independently():
    """Bug 2: resolving h1 must not mark signal COMPLETED and starve h5 and h15 passes."""
    from outcome_resolver import resolve_unified_outcomes
    conn = make_multi_horizon_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    conn.execute(
        "INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,signal_source,confidence_score) "
        "VALUES ('MULTI2',?,100.0,110.0,90.0,'AI',75)",
        (sig_date,)
    )
    _seed_ohlcv(conn, 'MULTI2', sig_date, exit_price=110.0, n_post=20)
    conn.commit()

    resolve_unified_outcomes(conn, horizon_days=1)
    resolve_unified_outcomes(conn, horizon_days=5)
    resolve_unified_outcomes(conn, horizon_days=15)

    rows = conn.execute(
        "SELECT horizon_days, outcome FROM unified_signal_outcomes WHERE symbol='MULTI2' ORDER BY horizon_days"
    ).fetchall()
    horizons_resolved = {r[0] for r in rows if r[1] not in ('PENDING', None)}
    assert 1 in horizons_resolved, "h1 outcome missing"
    assert 5 in horizons_resolved, "h5 outcome missing — Bug 2: COMPLETED flag starved h5"
    assert 15 in horizons_resolved, "h15 outcome missing — Bug 2: COMPLETED flag starved h15"
