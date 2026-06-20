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
            low REAL, close REAL, volume INTEGER,
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
        conn.execute("INSERT OR IGNORE INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)",
                     (symbol, day, price, price, price, price, 100000))


def add_signal(conn, symbol, *, stop_loss=None, score=6):
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, cmp, signal_score, signals_json, stop_loss, time_horizon) "
        "VALUES (?,?,100.0,?,'[]',?,'1 day')",
        (symbol, SIGNAL_DATE, score, stop_loss),
    )


def add_exit_bar(conn, symbol, *, open_=100.0, high=100.0, low=100.0, close=100.0):
    conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)",
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
