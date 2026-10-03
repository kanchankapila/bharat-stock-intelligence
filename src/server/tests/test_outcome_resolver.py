import sqlite3, sys, os, datetime
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

# Signals must be older than the resolver's 30-day cutoff (ts.date <= today-30).
SIGNAL_DATE = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
EXIT_DATE   = (datetime.date.today() - datetime.timedelta(days=39)).isoformat()  # signal + 1d horizon


def make_db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, cmp REAL, signal_score INTEGER,
            signals_json TEXT, stop_loss TEXT, time_horizon TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            label_definition TEXT, signal_source TEXT NOT NULL DEFAULT 'unknown',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
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
    add_signal(conn, 'WIPRO')  # no exit bar for WIPRO...
    add_exit_bar(conn, 'OTHER')  # ...but the session exists, so the signal is gradeable (AF-20260930-27)
    conn.commit()
    assert resolve(conn)['resolved'] == 0
    # No bar for WIPRO after its signal: not selected at all, so no PENDING row that
    # expire_stale_pending would later turn into a fabricated NEUTRAL (AF-20260930-16).
    assert get_row(conn, 'WIPRO') is None


def test_resolve_outcomes_excludes_suspect_bars():
    conn = make_db()
    seed_flat_history(conn, 'SUSP')
    add_signal(conn, 'SUSP')
    # the only post-signal bar is a flagged bad print that would otherwise be a +100% WIN
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume,is_suspect) "
                 "VALUES ('SUSP',?,100,200,100,200,100000,1)", (EXIT_DATE,))
    conn.commit()
    resolve(conn)
    assert get_row(conn, 'SUSP') is None   # nothing clean to resolve against -> no label at all


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


# ─── data-error guard: phantom returns must not count as wins/losses ─────────────────

def test_is_plausible_return_guard():
    from outcome_resolver import is_plausible_return, MAX_PLAUSIBLE_RETURN_PCT
    assert is_plausible_return(5.0)      # a normal swing return
    assert is_plausible_return(-40.0)    # a big but real drawdown
    assert is_plausible_return(MAX_PLAUSIBLE_RETURN_PCT)  # boundary is inclusive
    assert not is_plausible_return(188.0)     # phantom (was the poisoned per-source avg)
    assert not is_plausible_return(26325.26)  # phantom (max observed in unified_signal_outcomes)
    assert not is_plausible_return(-150.0)    # impossible on a long (below -100%)
    assert not is_plausible_return(None)      # unresolved


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
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE unified_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, signal_date TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL, signal_source TEXT,
            confidence_score REAL, status TEXT DEFAULT 'ACTIVE'
        );
        CREATE TABLE unified_signal_outcomes (
            unified_signal_id INTEGER, signal_source TEXT, symbol TEXT, signal_date TEXT,
            horizon_days INTEGER, entry_price REAL, entry_time TEXT, check_date TEXT,
            exit_price REAL, outcome TEXT, return_pct REAL, exit_reason TEXT,
            signal_score INTEGER, intraday_max_return_pct REAL, intraday_min_return_pct REAL,
            exit_time TEXT, computed_at TEXT,
            PRIMARY KEY (unified_signal_id, horizon_days)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL, low REAL, close REAL,
            volume INTEGER, is_suspect INTEGER DEFAULT 0, PRIMARY KEY (symbol, date)
        );
    """)
    return conn


def test_unified_signal_with_null_entry_uses_next_day_open():
    from outcome_resolver import resolve_unified_outcomes
    conn = make_unified_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    base = datetime.date.fromisoformat(sig_date)
    for i in range(15, 0, -1):
        d = (base - datetime.timedelta(days=i)).isoformat()
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) "
            "VALUES (?,?,100,100,100,100,100000)", ("NULL_ENTRY", d))
    conn.execute(
        "INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,signal_source,confidence_score) "
        "VALUES ('NULL_ENTRY',?,NULL,110,90,'AI',75)", (sig_date,))
    for offset, price in ((1, 101.0), (2, 102.0), (3, 103.0)):
        d = (base + datetime.timedelta(days=offset)).isoformat()
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) "
            "VALUES (?,?,?,?,?,?,100000)", ("NULL_ENTRY", d, price, price, price, price))
    for offset in (4, 5):
        d = (base + datetime.timedelta(days=offset)).isoformat()
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) "
            "VALUES (?,?,100,100,100,100,100000)", ("MARKET_CONTROL", d))
    conn.commit()

    result = resolve_unified_outcomes(conn, horizon_days=5)
    row = conn.execute(
        "SELECT entry_price, exit_price, outcome FROM unified_signal_outcomes WHERE symbol='NULL_ENTRY'"
    ).fetchone()
    assert result["resolved"] == 1
    assert row["entry_price"] == 101.0
    assert row["exit_price"] == 103.0
    assert row["outcome"] == "WIN"


def test_zero_neutral_repair_requeues_only_synthetic_labels_with_valid_bars():
    from data_integrity_repair import repair_zero_neutral_outcomes
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, is_suspect INTEGER DEFAULT 0)")
    conn.execute("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date DATE, outcome TEXT, return_pct DOUBLE PRECISION,
            exit_price DOUBLE PRECISION
        )
    """)
    conn.execute("""
        CREATE TABLE unified_signal_outcomes (
            symbol TEXT, signal_date DATE, outcome TEXT, return_pct DOUBLE PRECISION,
            exit_price DOUBLE PRECISION, exit_reason TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE recommendation_log (
            symbol TEXT, signal_date DATE, outcome TEXT, actual_return_pct DOUBLE PRECISION,
            actual_exit_price DOUBLE PRECISION, status TEXT, resolved_at TIMESTAMPTZ
        )
    """)
    signal_date = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    conn.execute("INSERT INTO stock_ohlcv VALUES ('LIVE', ?, 0)",
                 ((datetime.date.fromisoformat(signal_date) + datetime.timedelta(days=1)).isoformat(),))
    for table, columns in (
        ('signal_outcomes', 'symbol, signal_date, outcome, return_pct, exit_price'),
        ('unified_signal_outcomes', 'symbol, signal_date, outcome, return_pct, exit_price, exit_reason'),
    ):
        conn.execute(f"INSERT INTO {table} ({columns}) VALUES ('LIVE', ?, 'NEUTRAL', 0, NULL" +
                     (", NULL)" if table == 'unified_signal_outcomes' else ")"), (signal_date,))
        conn.execute(f"INSERT INTO {table} ({columns}) VALUES ('LIVE', ?, 'NEUTRAL', 0, 100" +
                     (", 'TIME_EXIT')" if table == 'unified_signal_outcomes' else ")"), (signal_date,))
    conn.execute("INSERT INTO recommendation_log VALUES ('LIVE', ?, 'NEUTRAL', 0, NULL, 'RESOLVED', now())",
                 (signal_date,))
    conn.execute("INSERT INTO recommendation_log VALUES ('LIVE', ?, 'NEUTRAL', 0, 100, 'RESOLVED', now())",
                 (signal_date,))
    conn.commit()

    repair_zero_neutral_outcomes(conn, dry=False)

    assert conn.execute("SELECT outcome FROM signal_outcomes WHERE exit_price IS NULL").fetchone()[0] == 'PENDING'
    assert conn.execute("SELECT outcome FROM signal_outcomes WHERE exit_price IS NOT NULL").fetchone()[0] == 'NEUTRAL'
    assert conn.execute("SELECT outcome FROM unified_signal_outcomes WHERE exit_price IS NULL").fetchone()[0] == 'PENDING'
    assert conn.execute("SELECT outcome FROM unified_signal_outcomes WHERE exit_price IS NOT NULL").fetchone()[0] == 'NEUTRAL'
    assert conn.execute("SELECT outcome FROM recommendation_log WHERE actual_exit_price IS NULL").fetchone()[0] == 'PENDING'
    assert conn.execute("SELECT outcome FROM recommendation_log WHERE actual_exit_price IS NOT NULL").fetchone()[0] == 'NEUTRAL'


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


def test_unified_outcomes_populates_signal_score_and_mfe_mae():
    """Regression test for the 2026-08-07 dead-column fix: signal_score/
    intraday_max_return_pct/intraday_min_return_pct had zero writers (confirmed live,
    89,713/89,713 rows null). Reuses the exact fixture from
    test_unified_target_capture_beats_faded_horizon_close (entry=100, spikes to high=106,
    dips to low=99) since its bars already exercise a real MFE/MAE range."""
    from outcome_resolver import resolve_unified_outcomes
    conn = make_unified_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    base = datetime.date.fromisoformat(sig_date)
    for i in range(15, 0, -1):
        d = (base - datetime.timedelta(days=i)).isoformat()
        conn.execute("INSERT OR IGNORE INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,100,100,100,100,100000)", ('QSC', d))
    conn.execute("INSERT INTO unified_signals (symbol, signal_date, entry_price, target_price, stop_loss, signal_source, confidence_score) "
                 "VALUES ('QSC', ?, 100, 105, 97, 'AI', 73.4)", (sig_date,))
    bars = [
        (1, 100, 106, 100, 104),
        (2, 102, 103, 100, 101),
        (3, 101, 102,  99, 100),
        (4, 100, 101,  99, 100),
        (5, 100, 100,  99, 100),
    ]
    for off, o, h, l, c in bars:
        d = (base + datetime.timedelta(days=off)).isoformat()
        conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,100000)", ('QSC', d, o, h, l, c))
    conn.commit()

    resolve_unified_outcomes(conn, horizon_days=5, dry_run=False)
    row = conn.execute(
        "SELECT signal_score, intraday_max_return_pct, intraday_min_return_pct, exit_time "
        "FROM unified_signal_outcomes WHERE symbol='QSC'"
    ).fetchone()
    assert row is not None
    signal_score, mfe, mae, exit_time = row
    assert signal_score == 73, "signal_score must be round(confidence_score) -- 73.4 -> 73"
    assert mfe == pytest.approx(6.0, abs=0.05), "MFE must reflect the real high of 106 vs entry 100"
    assert mae == pytest.approx(-1.0, abs=0.05), "MAE must reflect the real low of 99 vs entry 100"
    # Daily-bar path (no intraday_ohlcv seeded in this fixture) -- exit_time must stay NULL
    # rather than fabricate a midnight timestamp implying precision that isn't real.
    assert exit_time is None


def make_reclog_db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE recommendation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, signal_date TEXT,
            entry_price REAL, stop_loss REAL, target_1 REAL, horizon_days INTEGER,
            outcome TEXT, actual_exit_price REAL, actual_return_pct REAL,
            status TEXT, resolved_at TIMESTAMPTZ
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL, low REAL, close REAL,
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
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES ('ZED2',?,100,101,99,100,100000)",
                 ((base + datetime.timedelta(days=5)).isoformat(),))
    conn.commit()

    # h3: the 3rd session after the signal is base+5, so the suspect base+3 bar is inside the window
    resolve_unified_outcomes(conn, horizon_days=3, dry_run=False)
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
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, cmp REAL, signal_score INTEGER,
            signals_json TEXT, stop_loss TEXT, time_horizon TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            label_definition TEXT, signal_source TEXT NOT NULL DEFAULT 'unknown',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
        );
        CREATE TABLE unified_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, signal_date TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL, signal_source TEXT,
            confidence_score REAL, status TEXT DEFAULT 'ACTIVE'
        );
        CREATE TABLE unified_signal_outcomes (
            unified_signal_id INTEGER, signal_source TEXT, symbol TEXT, signal_date TEXT,
            horizon_days INTEGER, entry_price REAL, entry_time TEXT, check_date TEXT,
            exit_price REAL, outcome TEXT, return_pct REAL, exit_reason TEXT,
            signal_score INTEGER, intraday_max_return_pct REAL, intraday_min_return_pct REAL,
            exit_time TEXT, computed_at TEXT,
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


@pytest.mark.parametrize("fn_name, table, insert", [
    ("resolve_outcomes", "technical_signals",
     "INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
     "VALUES (?,?,100.0,6,'[]',NULL,NULL)"),
    ("resolve_unified_outcomes", "unified_signals",
     "INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,signal_source,confidence_score) "
     "VALUES (?,?,100.0,110.0,90.0,'AI',75)"),
])
def test_ungradeable_signals_do_not_take_batch_slots(fn_name, table, insert):
    """AF-20260930-27: the cutoff was today - h, so at the 09:30 IST run every signal from
    the last session (whose exit bar does not exist yet) was selected, came back PENDING,
    and -- at ~3,350 unified signals/day vs LIMIT 2000 -- starved every older gradeable row
    (0/2000 resolved, 1,400 rows of 2026-09-28 stranded). The cutoff must be anchored to the
    last session actually in stock_ohlcv."""
    import outcome_resolver
    conn = make_multi_horizon_db()
    last_session = datetime.date.today() - datetime.timedelta(days=30)
    old_sig = (last_session - datetime.timedelta(days=5)).isoformat()
    _seed_ohlcv(conn, 'OLDSIG', old_sig, n_post=5)          # bars up to last_session
    _seed_ohlcv(conn, 'NEWSIG', last_session.isoformat(), n_post=0)
    conn.execute(insert, ('OLDSIG', old_sig))
    conn.execute(insert, ('NEWSIG', last_session.isoformat()))
    conn.commit()

    result = getattr(outcome_resolver, fn_name)(conn, horizon_days=1)
    assert result == {'processed': 1, 'resolved': 1}


def test_signal_time_horizon_does_not_override_pass_horizon():
    """AF-20260930-28: the h5 pass selected by horizon_days=5 but wrote the row under
    parse_horizon(time_horizon) -- 'Positional (2-4W)' parsed to 2 DAYS -- so no horizon-5 row
    was ever written and every pass re-selected the signal forever."""
    from outcome_resolver import resolve_outcomes
    conn = make_multi_horizon_db()
    sig_date = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    conn.execute(
        "INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
        "VALUES ('POSN',?,100.0,6,'[]',NULL,'Positional (2-4W)')", (sig_date,))
    _seed_ohlcv(conn, 'POSN', sig_date, n_post=20)
    conn.commit()

    resolve_outcomes(conn, horizon_days=5)
    horizons = [r[0] for r in conn.execute(
        "SELECT horizon_days FROM signal_outcomes WHERE symbol='POSN'").fetchall()]
    assert horizons == [5]
    assert resolve_outcomes(conn, horizon_days=5)['processed'] == 0


def _seed_weekday_bars(conn, symbol, start, end, close=100.0):
    d = start
    while d <= end:
        if d.weekday() < 5:
            conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) "
                         "VALUES (?,?,?,?,?,?,100000)", (symbol, d.isoformat(), close, close, close, close))
        d += datetime.timedelta(days=1)


def _a_wednesday_weeks_ago(weeks=6):
    d = datetime.date.today() - datetime.timedelta(weeks=weeks)
    return d - datetime.timedelta(days=(d.weekday() - 2) % 7)


@pytest.mark.parametrize("fn_name, table_insert, out_table", [
    ("resolve_outcomes",
     "INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
     "VALUES (?,?,100.0,6,'[]',NULL,NULL)", "signal_outcomes"),
    ("resolve_unified_outcomes",
     "INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,signal_source,confidence_score) "
     "VALUES (?,?,100.0,500.0,10.0,'AI',75)", "unified_signal_outcomes"),
])
def test_horizon_counts_trading_sessions_not_calendar_days(fn_name, table_insert, out_table):
    """AF-20260930-30: h5 from a Wednesday exited on calendar-Monday (3 sessions), so the h5
    win rate was 8.1% for Monday signals vs 22.5% for Wednesday ones. h5 = 5th session."""
    import outcome_resolver
    conn = make_multi_horizon_db()
    wed = _a_wednesday_weeks_ago()
    _seed_weekday_bars(conn, 'SESS', wed - datetime.timedelta(days=30), wed + datetime.timedelta(days=21))
    conn.execute(table_insert, ('SESS', wed.isoformat()))
    conn.commit()

    getattr(outcome_resolver, fn_name)(conn, horizon_days=5)
    check = conn.execute(f"SELECT check_date FROM {out_table} WHERE symbol='SESS' AND horizon_days=5").fetchone()
    assert str(check[0])[:10] == (wed + datetime.timedelta(days=7)).isoformat()  # next Wednesday


@pytest.mark.parametrize("fn_name, seed_sql, out_table", [
    ("resolve_outcomes",
     ["INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
      "VALUES ('RELB',?,100.0,6,'[]',NULL,NULL)",
      "INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome,check_date,computed_at,signal_source) "
      "VALUES ('RELB',?,5,'WIN','calendar-era','2026-01-01','technical')"], "signal_outcomes"),
    ("resolve_unified_outcomes",
     ["INSERT INTO unified_signals (id,symbol,signal_date,entry_price,target_price,stop_loss,signal_source,confidence_score) "
      "VALUES (1,'RELB',?,100.0,500.0,10.0,'AI',75)",
      "INSERT INTO unified_signal_outcomes (unified_signal_id,symbol,signal_date,horizon_days,outcome,check_date,computed_at) "
      "VALUES (1,'RELB',?,5,'WIN','calendar-era','2026-01-01')"], "unified_signal_outcomes"),
])
def test_relabel_before_regrades_only_older_labels(fn_name, seed_sql, out_table):
    """AF-20260930-30 backfill: rows graded before the cutover are regraded under the session
    definition; without relabel_before a resolved row is never touched."""
    import outcome_resolver
    conn = make_multi_horizon_db()
    wed = _a_wednesday_weeks_ago()
    _seed_weekday_bars(conn, 'RELB', wed - datetime.timedelta(days=30), wed + datetime.timedelta(days=21))
    for sql in seed_sql:
        conn.execute(sql, (wed.isoformat(),))
    conn.commit()
    fn = getattr(outcome_resolver, fn_name)

    assert fn(conn, horizon_days=5)['processed'] == 0
    fn(conn, horizon_days=5, relabel_before='2026-06-01')
    check = conn.execute(f"SELECT check_date FROM {out_table} WHERE symbol='RELB' AND horizon_days=5").fetchone()
    assert str(check[0])[:10] == (wed + datetime.timedelta(days=7)).isoformat()


@pytest.mark.parametrize("fn_name, insert", [
    ("resolve_outcomes",
     "INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
     "VALUES (?,?,100.0,6,'[]',NULL,NULL)"),
    ("resolve_unified_outcomes",
     "INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,signal_source,confidence_score) "
     "VALUES (?,?,100.0,110.0,90.0,'AI',75)"),
])
def test_symbol_without_daily_bars_after_signal_is_not_graded(fn_name, insert):
    """AF-20260930-16: 2,379 unified signals on retired/untradeable codes (ZOMATO, INDIAVIX,
    CIGNITITEC...) with no daily bar after the signal were graded anyway -- 2,587 expired to a
    fabricated NEUTRAL, 1,543 WIN/LOSS from intraday-only bars. No canonical price, no label."""
    import outcome_resolver
    conn = make_multi_horizon_db()
    sig = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    _seed_ohlcv(conn, 'LIVE', sig, n_post=10)
    _seed_ohlcv(conn, 'GONE', sig, n_post=0)       # history up to the signal, nothing after
    conn.execute(insert, ('GONE', sig))
    conn.commit()
    assert getattr(outcome_resolver, fn_name)(conn, horizon_days=1)['processed'] == 0


def test_expire_does_not_fabricate_neutral_for_unpriced_symbol():
    """AF-20260930-16: 2,587 unified outcomes on retired/untradeable codes were expired to a
    0.0% NEUTRAL. With no canonical bar after the signal the row stays PENDING (ungraded)."""
    from outcome_resolver import expire_stale_pending
    conn = make_multi_horizon_db()
    sig = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    _seed_ohlcv(conn, 'GONE', sig, n_post=0)
    _seed_ohlcv(conn, 'SUSPD', sig, n_post=2)       # traded after the signal, then stopped
    conn.execute("CREATE TABLE recommendation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, "
                 "signal_date TEXT, horizon_days INTEGER, outcome TEXT, actual_return_pct REAL, "
                 "status TEXT, resolved_at TIMESTAMPTZ)")
    for sym in ('GONE', 'SUSPD'):
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome,signal_source) "
                     "VALUES (?,?,5,'PENDING','technical')", (sym, sig))
    conn.commit()
    expire_stale_pending(conn, horizon_days=5)
    got = dict(conn.execute("SELECT symbol, outcome FROM signal_outcomes").fetchall())
    assert got == {'GONE': 'PENDING', 'SUSPD': 'PENDING'}
    zero_labels = conn.execute(
        "SELECT count(*) FROM signal_outcomes WHERE outcome='NEUTRAL' AND return_pct=0 "
        "AND exit_price IS NULL"
    ).fetchone()[0]
    assert zero_labels == 0


def test_conflict_invalidated_signal_is_not_graded():
    """AF-20260930-33: 31,189 of ~34,400 September screener outcomes graded signals the scan had
    itself withdrawn as INVALIDATED_CONFLICT (BUY then SELL same day) -- a 3.3% win rate
    swamping the 3,207 live ones."""
    from outcome_resolver import resolve_unified_outcomes
    conn = make_multi_horizon_db()
    sig = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    _seed_ohlcv(conn, 'FLIP', sig, n_post=10)
    conn.execute("INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,"
                 "signal_source,confidence_score,status) VALUES ('FLIP',?,100,105,97,'screener',80,"
                 "'INVALIDATED_CONFLICT')", (sig,))
    conn.commit()
    assert resolve_unified_outcomes(conn, horizon_days=1)['processed'] == 0


def test_nth_session_after_edges():
    from outcome_resolver import _nth_session_after
    cal = ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-30']  # 09-29 a holiday
    assert _nth_session_after(cal, '2026-09-25', 1) == '2026-09-28'   # Fri -> Mon
    assert _nth_session_after(cal, '2026-09-26', 1) == '2026-09-28'   # Sat -> Mon
    assert _nth_session_after(cal, '2026-09-24', 3) == '2026-09-30'   # skips the holiday
    assert _nth_session_after(cal, '2026-09-28', 3) > '2026-09-30'    # not yet traded -> PENDING


def test_weekend_dated_signal_is_gradeable_once_next_session_exists():
    from outcome_resolver import resolve_outcomes
    conn = make_multi_horizon_db()
    sat = _a_wednesday_weeks_ago() + datetime.timedelta(days=3)
    _seed_weekday_bars(conn, 'WKND', sat - datetime.timedelta(days=30), sat + datetime.timedelta(days=2))  # ends Monday
    conn.execute("INSERT INTO technical_signals (symbol,date,cmp,signal_score,signals_json,stop_loss,time_horizon) "
                 "VALUES ('WKND',?,100.0,6,'[]',NULL,NULL)", (sat.isoformat(),))
    conn.commit()
    assert resolve_outcomes(conn, horizon_days=1)['processed'] == 1


class _FailingConn:
    def execute(self, *_a, **_k):
        raise RuntimeError("boom: syntax error at or near \":\"\nDETAIL: second line is dropped")


@pytest.mark.parametrize("fn_name, arg, empty", [
    ("_prefetch_next_price", [("A", "2026-01-02", "AFTER_OPEN")], {}),
    ("_prefetch_sl_hits", [("A", "2026-01-02", "2026-01-09", 95.0)], {}),
    ("_prefetch_resolved_keys", [("A", "2026-01-02", 1)], set()),
    ("_prefetch_bar_windows", [("A", "2026-01-02", "2026-01-09")], {}),
])
def test_prefetch_failure_is_loud_not_silent(capsys, fn_name, arg, empty):
    """AF-20260901: a batched prefetch died with a SQL syntax error 136 times and the bare
    `except Exception: continue` hid it. Result stays empty (callers fall back), but the failure
    must reach stderr, naming the function, and must not dump the statement/params."""
    import outcome_resolver
    assert getattr(outcome_resolver, fn_name)(_FailingConn(), arg) == empty
    err = capsys.readouterr().err
    assert fn_name in err and "RuntimeError" in err and "boom" in err
    assert "second line" not in err


def make_db_native_date_outcomes():
    """Same tables as make_db(), but signal_outcomes.signal_date is NATIVE DATE — the live
    production type (information_schema + db/schema.postgres.sql, converted by the 2026-09-03
    date-cols-to-date migration batch). The shared make_db() fixture still models the
    pre-conversion TEXT column, which is why the suite stayed green while production's
    _prefetch_resolved_keys warned `date = text` on every run (2026-09-28)."""
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, cmp REAL, signal_score INTEGER,
            signals_json TEXT, stop_loss TEXT, time_horizon TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date DATE, horizon_days INTEGER,
            entry_price REAL, check_date DATE, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TIMESTAMPTZ DEFAULT now(),
            label_definition TEXT, signal_source TEXT NOT NULL DEFAULT 'unknown',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
        );
    """)
    return conn


def test_prefetch_resolved_keys_matches_native_date_column():
    """AF-20260928: _prefetch_resolved_keys must CAST its signal_date binds to DATE.
    With plain text binds the VALUES column inferred TEXT, `so.signal_date = p.signal_date`
    became `date = text` (ProgrammingError), every chunk was skipped, and the function
    silently returned an empty set — degrading every run to the per-row guard. This test
    fails (empty set) against the pre-fix text-bind form and passes only with the cast."""
    from outcome_resolver import _prefetch_resolved_keys
    conn = make_db_native_date_outcomes()
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, signal_source) "
        "VALUES ('ABX', ?, 1, 100.0, 'WIN', 'technical')",
        (SIGNAL_DATE,),
    )
    # PENDING at the same key shape must NOT count as resolved (pins the outcome <> 'PENDING'
    # predicate surviving the type change), and a confluence-sourced row must not either
    # (pins the signal_source = 'technical' predicate).
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, signal_source) "
        "VALUES ('ABX', ?, 5, 100.0, 'PENDING', 'technical')",
        (SIGNAL_DATE,),
    )
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, signal_source) "
        "VALUES ('ABX', ?, 15, 100.0, 'WIN', 'confluence')",
        (SIGNAL_DATE,),
    )
    conn.commit()
    got = _prefetch_resolved_keys(conn, [("ABX", SIGNAL_DATE, 1), ("ABX", SIGNAL_DATE, 5), ("ABX", SIGNAL_DATE, 15)])
    assert ("ABX", SIGNAL_DATE, 1) in got, "resolved technical WIN row not prefetched — date = text regression"
    assert ("ABX", SIGNAL_DATE, 5) not in got, "PENDING row must not count as resolved"
    assert ("ABX", SIGNAL_DATE, 15) not in got, "confluence-sourced row must not count as resolved"


def test_expire_all_horizons_covers_horizons_no_caller_passes():
    """AF-20261001-01: the outcome tables carry horizons {1,2,3,5,7,14,15,30} (written by their
    own engines), but run() was only ever invoked with 1/5/15 — so a horizon nobody passed was
    never resolved and never expired: 269 h7 PENDING rows sat past their window, every one
    priceable. The sweep must derive its horizons from the tables, not the caller."""
    from outcome_resolver import expire_stale_pending_all, stale_pending_horizons
    conn = make_multi_horizon_db()
    sig = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    _seed_ohlcv(conn, 'H7LIVE', sig, n_post=10)
    _seed_ohlcv(conn, 'H7GONE', sig, n_post=0)  # no bar after the signal: AF-20260930-16 guard
    for sym in ('H7LIVE', 'H7GONE'):
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome,signal_source) "
                     "VALUES (?,?,7,'PENDING','confluence')", (sym, sig))
    # stale_pending_horizons unions all three outcome tables; production always has rec_log,
    # so the derivation query must not depend on the test fixture having rows in it.
    conn.execute("CREATE TABLE recommendation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, "
                 "signal_date TEXT, horizon_days INTEGER, outcome TEXT, actual_return_pct REAL, "
                 "status TEXT, resolved_at TIMESTAMPTZ)")
    conn.commit()
    assert stale_pending_horizons(conn) == [7]
    assert expire_stale_pending_all(conn) == 1
    got = dict(conn.execute("SELECT symbol, outcome FROM signal_outcomes").fetchall())
    assert got == {'H7LIVE': 'PENDING', 'H7GONE': 'PENDING'}, \
        "expiry must count stale work without fabricating a zero-return outcome"


def test_stale_pending_horizons_includes_unified_and_coalesces_rec_log_null():
    """AF-20261001-01: the horizon list must come from all three outcome tables, and rec_log's
    NULL horizon (expire treats it as 15 via COALESCE) must map to 15, not be dropped."""
    from outcome_resolver import stale_pending_horizons
    conn = make_multi_horizon_db()
    sig = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    conn.execute("INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,"
                 "signal_source,confidence_score) VALUES ('U7',?,100.0,110.0,90.0,'AI',75)", (sig,))
    conn.execute("INSERT INTO unified_signal_outcomes (unified_signal_id,symbol,signal_date,horizon_days,"
                 "outcome) VALUES (1,'U7',?,30,'PENDING')", (sig,))
    conn.execute("CREATE TABLE recommendation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, "
                 "signal_date TEXT, horizon_days INTEGER, outcome TEXT, actual_return_pct REAL, "
                 "status TEXT, resolved_at TIMESTAMPTZ)")
    conn.execute("INSERT INTO recommendation_log (symbol,signal_date,horizon_days,outcome) "
                 "VALUES ('U7',?,NULL,'PENDING')", (sig,))
    conn.commit()
    assert stale_pending_horizons(conn) == [15, 30]
