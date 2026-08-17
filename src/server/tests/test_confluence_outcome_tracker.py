import sqlite3, sys, os, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

from confluence_outcome_tracker import track_outcomes, recompute_screener_reliability  # noqa: E402

SIGNAL_DATE = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()


def make_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE confluence_signals (
            symbol TEXT, computed_at TEXT, current_price REAL, screener_ids_json TEXT
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, close REAL, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            label_definition TEXT, signal_source TEXT NOT NULL DEFAULT 'unknown',
            is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
        );
        CREATE TABLE trendlyne_screeners (screener_id TEXT PRIMARY KEY, screener_name TEXT);
        CREATE TABLE trendlyne_screener_stocks (screener_id TEXT, symbol TEXT);
        CREATE TABLE moneycontrol_screeners (scan_id TEXT PRIMARY KEY, screener_name TEXT);
        CREATE TABLE moneycontrol_screener_stocks (scan_id TEXT, symbol TEXT);
        CREATE TABLE etnow_screeners (screener_id TEXT PRIMARY KEY, screener_name TEXT);
        CREATE TABLE etnow_screener_stocks (screener_id TEXT, symbol TEXT);
        CREATE TABLE screener_reliability (
            scan_id TEXT, screener_name TEXT, source TEXT,
            total_signals INTEGER DEFAULT 0, wins_7d INTEGER DEFAULT 0,
            win_rate_7d REAL DEFAULT 0, avg_return_7d REAL DEFAULT 0,
            wins_30d INTEGER DEFAULT 0, win_rate_30d REAL DEFAULT 0,
            avg_return_30d REAL DEFAULT 0, max_drawdown REAL DEFAULT 0,
            reliability_score REAL DEFAULT 0, last_updated TEXT,
            PRIMARY KEY (source, scan_id)
        );
        -- 2026-08-04: sentiment source for the direction-aware sign fix. Empty by default --
        -- an absent/unmatched (scan_id, source) pair defaults to bullish (sign=+1), matching
        -- prior behavior, so existing tests that don't seed this table are unaffected.
        CREATE TABLE screener_master (scan_id TEXT, source TEXT, inferred_sentiment TEXT);
    """)
    return conn


def _seed_confluence_signal(conn, symbol, price=100.0):
    conn.execute(
        "INSERT INTO confluence_signals (symbol, computed_at, current_price, screener_ids_json) "
        "VALUES (?, ?, ?, '[]')",
        (symbol, SIGNAL_DATE, price),
    )


def _seed_close(conn, symbol, horizon_days, close):
    d = (datetime.date.fromisoformat(SIGNAL_DATE) + datetime.timedelta(days=horizon_days)).isoformat()
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close) VALUES (?, ?, ?)", (symbol, d, close))


# ─── writer: signal_source / label_definition stamping (2026-08 fix) ──────────────

def test_track_outcomes_stamps_confluence_source_and_terminal_pct2_label():
    conn = make_db()
    _seed_confluence_signal(conn, 'AAA')
    for h in (1, 3, 7, 14, 30):
        _seed_close(conn, 'AAA', h, 105.0)  # +5% -> WIN under the fixed +/-2% barrier
    conn.commit()

    tracked = track_outcomes(conn)
    assert tracked == 5

    rows = conn.execute(
        "SELECT horizon_days, outcome, signal_source, label_definition FROM signal_outcomes "
        "WHERE symbol='AAA' ORDER BY horizon_days"
    ).fetchall()
    assert len(rows) == 5
    for r in rows:
        assert r['signal_source'] == 'confluence'
        assert r['label_definition'] == 'terminal_pct2'
        assert r['outcome'] == 'WIN'


def test_track_outcomes_uses_fixed_2pct_barrier():
    conn = make_db()
    _seed_confluence_signal(conn, 'BBB')
    _seed_close(conn, 'BBB', 7, 101.5)   # +1.5% -> NEUTRAL (inside +/-2%)
    _seed_close(conn, 'BBB', 14, 98.5)   # -1.5% -> NEUTRAL
    _seed_close(conn, 'BBB', 30, 97.0)   # -3.0% -> LOSS
    conn.commit()

    track_outcomes(conn)

    out = {r['horizon_days']: r['outcome'] for r in conn.execute(
        "SELECT horizon_days, outcome FROM signal_outcomes WHERE symbol='BBB'"
    ).fetchall()}
    assert out[7] == 'NEUTRAL'
    assert out[14] == 'NEUTRAL'
    assert out[30] == 'LOSS'


# ─── the actual bug: dedup must be source-scoped, not global (2026-08 fix) ────────

def test_track_outcomes_does_not_skip_a_horizon_already_claimed_by_technical_source():
    """Before the fix, confluence_outcome_tracker's existing_outcomes check matched ANY row
    for (symbol, signal_date, horizon_days) regardless of writer -- so if outcome_resolver.py
    had already written a 'technical' row for this exact key, this script silently skipped
    writing its OWN confluence-sourced row. The fix scopes the pre-check to signal_source, so
    both can coexist."""
    conn = make_db()
    # Simulate outcome_resolver.py having already resolved h1 for this (symbol, date) as
    # 'technical' -- same PK-relevant fields, different signal_source.
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "signal_source, label_definition) VALUES ('CCC', ?, 1, 100.0, 'WIN', 'technical', 'path_barrier')",
        (SIGNAL_DATE,),
    )
    _seed_confluence_signal(conn, 'CCC')
    _seed_close(conn, 'CCC', 1, 103.0)  # would be WIN under the confluence +/-2% barrier too
    conn.commit()

    tracked = track_outcomes(conn)

    assert tracked == 1, "confluence-sourced h1 row must be written even though a technical-sourced h1 row already exists"
    rows = conn.execute(
        "SELECT signal_source, outcome FROM signal_outcomes WHERE symbol='CCC' AND horizon_days=1 ORDER BY signal_source"
    ).fetchall()
    assert [r['signal_source'] for r in rows] == ['confluence', 'technical']


# ─── recompute_screener_reliability must not blend technical-sourced rows ─────────

def test_recompute_screener_reliability_only_counts_confluence_source():
    conn = make_db()
    conn.execute("INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-1', 'Test Screener')")
    conn.execute("INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-1', 'DDD')")

    # A technical-sourced row at h7 with an opposite outcome to what the confluence row says --
    # if the query doesn't filter by signal_source, this would corrupt the reliability score.
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source) VALUES ('DDD', ?, 7, 100.0, 'LOSS', -20.0, 'technical')",
        (SIGNAL_DATE,),
    )
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source) VALUES ('DDD', ?, 7, 100.0, 'WIN', 5.0, 'confluence')",
        (SIGNAL_DATE,),
    )
    conn.commit()

    recompute_screener_reliability(conn)

    row = conn.execute("SELECT total_signals, wins_7d, win_rate_7d FROM screener_reliability WHERE scan_id='et-1'").fetchone()
    assert row['total_signals'] == 1, "must only count the confluence-sourced row, not both"
    assert row['wins_7d'] == 1
    assert row['win_rate_7d'] == 1.0


# ─── 2026-08-04: bad-bar (is_suspect) guard + sentiment-aware win/return direction ─

def test_track_outcomes_skips_suspect_ohlcv_bar_and_uses_next_clean_one():
    """A known-bad bar (is_suspect=1, e.g. a circuit-lock/impossible-move day flagged by
    data_integrity_repair.py) must not be used to price an exit -- the writer should fall
    through to the next clean bar within the 5-day lookforward window, same defensive pattern
    outcome_resolver.py already uses for the technical-sourced sibling table."""
    conn = make_db()
    _seed_confluence_signal(conn, 'EEE', price=100.0)
    d = (datetime.date.fromisoformat(SIGNAL_DATE) + datetime.timedelta(days=7)).isoformat()
    d1 = (datetime.date.fromisoformat(SIGNAL_DATE) + datetime.timedelta(days=8)).isoformat()
    # day+7 is a flagged bad bar showing an implausible spike -- must be ignored
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close, is_suspect) VALUES ('EEE', ?, 500.0, 1)", (d,))
    # day+8 is the real, clean bar
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close, is_suspect) VALUES ('EEE', ?, 101.0, 0)", (d1,))
    conn.commit()

    track_outcomes(conn)

    row = conn.execute(
        "SELECT exit_price, return_pct, outcome FROM signal_outcomes WHERE symbol='EEE' AND horizon_days=7"
    ).fetchone()
    assert row is not None
    assert row['exit_price'] == 101.0, "must skip the suspect bar's 500.0 close and use the clean 101.0 bar"
    assert row['outcome'] == 'NEUTRAL'  # +1% is inside the +/-2% barrier


def test_recompute_screener_reliability_sign_flips_bearish_screener():
    """A bearish-tagged screener (e.g. 'Near 52 Week Low', 'RSI Bearish') is doing its job when
    the stock subsequently FALLS -- a raw price-up=win metric scores that as a loss, which is
    backwards. Before this fix reliability_score/win_rate/avg_return were computed identically
    for bullish and bearish screeners; this asserts the sign flip: WIN<->LOSS swap, avg_return
    negated, so a genuinely-predictive bearish screener reads as reliable, not as garbage."""
    conn = make_db()
    conn.execute("INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('bear-1', 'Bearish Test Screener')")
    conn.execute("INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('bear-1', 'FFF')")
    conn.execute("INSERT INTO screener_master (scan_id, source, inferred_sentiment) VALUES ('bear-1', 'ETnow', 'bearish')")

    # The stock FELL 10% -- exactly what a bearish screener should predict. Raw outcome/
    # return_pct (as track_outcomes/outcome_resolver would have stamped them) are price-
    # direction-only: outcome='LOSS' (price fell), return_pct=-10.0.
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source) VALUES ('FFF', ?, 30, 100.0, 'LOSS', -10.0, 'confluence')",
        (SIGNAL_DATE,),
    )
    conn.commit()

    recompute_screener_reliability(conn)

    row = conn.execute(
        "SELECT wins_30d, win_rate_30d, avg_return_30d, reliability_score FROM screener_reliability WHERE scan_id='bear-1'"
    ).fetchone()
    assert row['wins_30d'] == 1, "a bearish screener 'wins' when the stock falls -- raw outcome='LOSS' must count as a win"
    assert row['win_rate_30d'] == 1.0
    assert row['avg_return_30d'] == 10.0, "avg_return must be sign-flipped (-10.0 raw -> +10.0 signed) for a bearish screener"
    # reliability = win_rate_7*40 + win_rate_30*30 + clamp(avg_ret_7,0,10)/10*20 + (1-max_dd/20)*10.
    # No 7d data seeded here (win_rate_7/avg_ret_7 both 0), so pre-fix (win_rate_30 unsigned=0,
    # since 'LOSS' would not count as a win) this would have scored 0+0+0+10=10; post-fix
    # (win_rate_30 signed=1.0) it scores 0+30+0+10=40 -- a real, correctly-directional jump for
    # a screener that predicted the move exactly right, even though the 30d-only weight caps it
    # below the "reliable" tiers a screener with matching 7d history would also clear.
    assert row['reliability_score'] == 40.0


def test_recompute_screener_reliability_leaves_bullish_screener_unsigned():
    """Control: a bullish-tagged screener's win/return computation is unchanged by the fix --
    price-up is still a win, price-down is still a loss, no sign flip applied."""
    conn = make_db()
    conn.execute("INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('bull-1', 'Bullish Test Screener')")
    conn.execute("INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('bull-1', 'GGG')")
    conn.execute("INSERT INTO screener_master (scan_id, source, inferred_sentiment) VALUES ('bull-1', 'ETnow', 'bullish')")
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source) VALUES ('GGG', ?, 30, 100.0, 'WIN', 8.0, 'confluence')",
        (SIGNAL_DATE,),
    )
    conn.commit()

    recompute_screener_reliability(conn)

    row = conn.execute(
        "SELECT wins_30d, win_rate_30d, avg_return_30d FROM screener_reliability WHERE scan_id='bull-1'"
    ).fetchone()
    assert row['wins_30d'] == 1
    assert row['avg_return_30d'] == 8.0, "bullish screener's avg_return must NOT be sign-flipped"


def test_recompute_screener_reliability_excludes_suspect_signal_outcomes():
    """signal_outcomes.is_suspect (maintained by data_integrity_repair.py's magnitude-based
    flag) must exclude a row from the win/return aggregate -- a 900% 'return' from a bad bar
    must not be averaged into a screener's reliability score."""
    conn = make_db()
    conn.execute("INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('sus-1', 'Suspect Test Screener')")
    conn.execute("INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('sus-1', 'HHH')")
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source, is_suspect) VALUES ('HHH', ?, 30, 100.0, 'WIN', 900.0, 'confluence', 1)",
        (SIGNAL_DATE,),
    )
    conn.commit()

    recompute_screener_reliability(conn)

    row = conn.execute("SELECT total_signals FROM screener_reliability WHERE scan_id='sus-1'").fetchone()
    assert row is None or row['total_signals'] == 0, "the is_suspect=1 row must be excluded entirely"


def test_recompute_screener_reliability_defaults_to_bullish_when_sentiment_unmatched():
    """A screener_id with no screener_master row (or an unmatched source casing) defaults to
    sign=+1 -- unchanged prior behavior, not silently treated as bearish."""
    conn = make_db()
    conn.execute("INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('unk-1', 'Unclassified Screener')")
    conn.execute("INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('unk-1', 'III')")
    # no screener_master row at all for 'unk-1'
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source) VALUES ('III', ?, 30, 100.0, 'WIN', 6.0, 'confluence')",
        (SIGNAL_DATE,),
    )
    conn.commit()

    recompute_screener_reliability(conn)

    row = conn.execute("SELECT avg_return_30d FROM screener_reliability WHERE scan_id='unk-1'").fetchone()
    assert row['avg_return_30d'] == 6.0
