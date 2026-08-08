import sqlite3, sys, os, datetime
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import screener_performance as sp  # noqa: E402
from screener_performance import (  # noqa: E402
    _sign_for_sentiment, get_price_on_or_after, get_trading_days_after,
    phase_c_bayesian, phase_b_fill_returns,
)

TODAY = datetime.date.today()


class CastStrippingConn:
    """phase_c_bayesian -> _adaptive_k_prior() uses raw Postgres `::date` cast syntax (this
    module is only ever run through db_compat's SQLAlchemy/Postgres path in production, never
    against raw SQLite) -- same gap test_screener_pit_scores.py's FakeConn already works around
    for compute_pit_scores(). sqlite3.Row-compatible: wraps a real connection, not a fake one."""

    def __init__(self, conn):
        self._c = conn

    def execute(self, sql, params=()):
        return self._c.execute(sql.replace('::date', '').replace('::text', ''), params)

    def commit(self):
        self._c.commit()


def make_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, close REAL, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE screener_master (scan_id TEXT, source TEXT, inferred_sentiment TEXT);
        CREATE TABLE screener_appearances (
            screener_id TEXT, source TEXT, symbol TEXT, appeared_date TEXT, exited_date TEXT,
            return_5d REAL, return_10d REAL, return_20d REAL, return_60d REAL, return_120d REAL,
            nifty_ret_20d REAL, outcome_20d TEXT
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER, return_pct REAL, outcome TEXT,
            signal_source TEXT, is_suspect INTEGER DEFAULT 0
        );
        CREATE TABLE confluence_signals (symbol TEXT, screener_ids_json TEXT, computed_at TEXT);
        CREATE TABLE screener_performance_v2 (
            screener_id TEXT, source TEXT, total_appearances INTEGER, resolved_count INTEGER,
            wr_5d REAL, wr_10d REAL, wr_20d REAL, wr_60d REAL, wr_120d REAL,
            avg_ret_5d REAL, avg_ret_10d REAL, avg_ret_20d REAL, avg_ret_60d REAL, avg_ret_120d REAL,
            alpha_20d REAL, alpha_60d REAL, sharpe_20d REAL, max_drawdown REAL, median_ret_20d REAL,
            bayesian_score REAL, tier TEXT, data_source TEXT, last_computed TEXT,
            PRIMARY KEY (screener_id, source)
        );
    """)
    return conn


def _seed_appearance(conn, screener_id, symbol, appeared_days_ago, return_20d, nifty_ret_20d=0.0):
    d = (TODAY - datetime.timedelta(days=appeared_days_ago)).isoformat()
    conn.execute(
        "INSERT INTO screener_appearances (screener_id, source, symbol, appeared_date, "
        "return_20d, nifty_ret_20d, outcome_20d) VALUES (?, 'trendlyne', ?, ?, ?, ?, 'WIN')",
        (screener_id, symbol, d, return_20d, nifty_ret_20d),
    )


# ─── _sign_for_sentiment: pure function ────────────────────────────────────────────

def test_sign_for_sentiment_bearish_flips():
    assert _sign_for_sentiment('bearish') == -1.0


def test_sign_for_sentiment_bullish_unsigned():
    assert _sign_for_sentiment('bullish') == 1.0


def test_sign_for_sentiment_neutral_unsigned():
    """neutral is deliberately NOT flipped -- it's not a directional claim to reverse."""
    assert _sign_for_sentiment('neutral') == 1.0


def test_sign_for_sentiment_none_defaults_unsigned():
    assert _sign_for_sentiment(None) == 1.0


# ─── bad-bar guard: get_price_on_or_after / get_trading_days_after ─────────────────

def test_get_price_on_or_after_skips_suspect_bar():
    conn = make_db()
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close, is_suspect) VALUES ('AAA', '2026-01-01', 999.0, 1)")
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close, is_suspect) VALUES ('AAA', '2026-01-02', 105.0, 0)")
    conn.commit()
    price = get_price_on_or_after(conn, 'AAA', '2026-01-01')
    assert price == 105.0, "must skip the suspect bar and return the next clean one"


def test_get_trading_days_after_skips_suspect_bar_in_count():
    conn = make_db()
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close) VALUES ('BBB', '2026-01-01', 100.0)")
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close, is_suspect) VALUES ('BBB', '2026-01-02', 500.0, 1)")
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close) VALUES ('BBB', '2026-01-03', 102.0)")
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close) VALUES ('BBB', '2026-01-04', 103.0)")
    conn.commit()
    # 2 trading days after 2026-01-01, excluding the suspect 01-02 bar -> lands on 01-04
    price, date = get_trading_days_after(conn, 'BBB', '2026-01-01', 2)
    assert price == 103.0
    assert date == '2026-01-04'


# ─── phase_c_bayesian: direction-aware win/return ──────────────────────────────────

def test_phase_c_sign_flips_bearish_screener_return():
    conn = make_db()
    conn.execute("INSERT INTO screener_master (scan_id, source, inferred_sentiment) VALUES ('bear-scr', 'trendlyne', 'bearish')")
    # Stock fell 12% after appearing in a bearish screener -- exactly the predicted direction.
    _seed_appearance(conn, 'bear-scr', 'CCC', appeared_days_ago=40, return_20d=-12.0)
    conn.commit()

    phase_c_bayesian(CastStrippingConn(conn), {})

    row = conn.execute(
        "SELECT wr_20d, avg_ret_20d, bayesian_score FROM screener_performance_v2 WHERE screener_id='bear-scr'"
    ).fetchone()
    assert row['wr_20d'] == 1.0, "a bearish screener whose stock fell must register as a WIN, not a loss"
    assert row['avg_ret_20d'] == 12.0, "avg_ret_20d must be sign-flipped positive for a correctly-predicting bearish screener"


def test_phase_c_leaves_bullish_screener_return_unsigned():
    conn = make_db()
    conn.execute("INSERT INTO screener_master (scan_id, source, inferred_sentiment) VALUES ('bull-scr', 'trendlyne', 'bullish')")
    _seed_appearance(conn, 'bull-scr', 'DDD', appeared_days_ago=40, return_20d=9.0)
    conn.commit()

    phase_c_bayesian(CastStrippingConn(conn), {})

    row = conn.execute(
        "SELECT wr_20d, avg_ret_20d FROM screener_performance_v2 WHERE screener_id='bull-scr'"
    ).fetchone()
    assert row['wr_20d'] == 1.0
    assert row['avg_ret_20d'] == 9.0, "bullish screener's return must not be sign-flipped"


def test_phase_c_bearish_screener_that_predicted_wrong_scores_as_a_loss():
    """Control: a bearish screener whose stock actually ROSE must register as a loss under the
    signed convention (raw +8% -> signed -8%), not a win -- the fix must discriminate correctly,
    not just uniformly inflate every bearish screener's score."""
    conn = make_db()
    conn.execute("INSERT INTO screener_master (scan_id, source, inferred_sentiment) VALUES ('bear-wrong', 'trendlyne', 'bearish')")
    _seed_appearance(conn, 'bear-wrong', 'EEE', appeared_days_ago=40, return_20d=8.0)
    conn.commit()

    phase_c_bayesian(CastStrippingConn(conn), {})

    row = conn.execute(
        "SELECT wr_20d, avg_ret_20d FROM screener_performance_v2 WHERE screener_id='bear-wrong'"
    ).fetchone()
    assert row['wr_20d'] == 0.0, "a bearish screener whose stock rose must NOT register as a win"
    assert row['avg_ret_20d'] == -8.0

# NOTE: compute_pit_scores() (Phase F) has the identical sign-awareness fix applied, covered in
# test_screener_pit_scores.py (that file already owns compute_pit_scores' test fixture/FakeConn
# pattern -- see test_screener_pit_scores_sign_flips_bearish_screener there) rather than
# duplicated here.


# ─── run(): write-target date must be logical_trading_date(), not date.today() ────────────

class _StubConn:
    """Just enough of ConnWrapper for run()'s two post-pipeline summary queries."""

    def execute(self, sql, params=()):
        class _Result:
            def fetchone(self):
                return (0,)

            def fetchall(self):
                return []
        return _Result()

    def close(self):
        pass


def test_run_passes_logical_trading_date_to_phase_f_pit():
    """2026-08-06: run() called phase_f_pit(conn, datetime.date.today().isoformat()) -- but
    screener-performance's cron fires at 21:00 UTC = 02:30 IST, always AFTER midnight relative
    to the trading day it summarizes. A raw date.today() call there permanently stamped every
    PIT snapshot one calendar day ahead of the data it reflects (same bug class as
    dl_engine.py/insider_features.py). run() must route through logical_trading_date() instead."""
    seen = {}

    def _fake_phase_f_pit(conn, as_of):
        seen['as_of'] = as_of
        return 0

    with patch.object(sp, 'connect', return_value=_StubConn()), \
         patch.object(sp, 'phase_a_bootstrap', return_value={}), \
         patch.object(sp, 'phase_b_fill_returns'), \
         patch.object(sp, 'phase_c_bayesian'), \
         patch.object(sp, 'phase_d_sync_back'), \
         patch.object(sp, 'phase_e_update_confidence'), \
         patch.object(sp, 'phase_f_pit', side_effect=_fake_phase_f_pit), \
         patch.object(sp, 'logical_trading_date', return_value='2026-07-31'):
        sp.run()

    assert seen['as_of'] == '2026-07-31', (
        "run() must pass logical_trading_date()'s value to phase_f_pit(), not date.today()"
    )


# ─── phase_b_fill_returns: re-selection across horizons (2026-08-07 fix) ───────────

def _seed_ohlcv_run(conn, symbol, start_date, num_days, base_price=100.0):
    """Seeds num_days consecutive daily bars starting at start_date (treats every day as a
    trading day -- fine for this fixture, get_trading_days_after just walks ordered rows)."""
    d = datetime.date.fromisoformat(start_date)
    for i in range(num_days):
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol, date, close) VALUES (?, ?, ?)",
            (symbol, (d + datetime.timedelta(days=i)).isoformat(), base_price + i),
        )
    conn.commit()


def test_phase_b_reselects_a_row_whose_return_5d_is_already_filled_but_return_60d_is_not():
    """The bug: the old WHERE clause only ever selected rows with return_5d IS NULL, so a row
    processed once (return_5d filled, return_60d/120d still None because not enough forward
    OHLCV existed yet at that time) was never revisited. Simulates that exact prior-run state
    directly, then asserts a second phase_b_fill_returns() call fills return_60d."""
    conn = make_db()
    appeared = (TODAY - datetime.timedelta(days=200)).isoformat()
    # Pre-seed as if a prior run already filled the short horizons (the buggy behavior's result).
    conn.execute(
        "INSERT INTO screener_appearances (screener_id, source, symbol, appeared_date, "
        "return_5d, return_10d, return_20d, return_60d, return_120d) "
        "VALUES ('scr1', 'trendlyne', 'DDD', ?, 2.0, 3.0, 4.0, NULL, NULL)",
        (appeared,),
    )
    conn.commit()
    # 130 consecutive daily bars from the appearance date covers a 120-"trading"-day forward
    # lookup in this fixture (every day counts as a trading day here).
    _seed_ohlcv_run(conn, 'DDD', appeared, 130)

    filled = phase_b_fill_returns(CastStrippingConn(conn))
    assert filled == 1, "the row must be re-selected even though return_5d is already non-NULL"

    row = conn.execute(
        "SELECT return_5d, return_60d, return_120d FROM screener_appearances WHERE symbol='DDD'"
    ).fetchone()
    assert row['return_60d'] is not None, "return_60d must now be filled"
    assert row['return_120d'] is not None, "return_120d must now be filled"
    # return_5d must still be correct (idempotent recompute), not clobbered with something else.
    assert row['return_5d'] is not None


def test_phase_b_does_not_reselect_a_fully_filled_row():
    """Once all 5 horizons are filled, the row must drop out of `pending` -- otherwise every
    run would rescan the entire historical table forever."""
    conn = make_db()
    appeared = (TODAY - datetime.timedelta(days=200)).isoformat()
    conn.execute(
        "INSERT INTO screener_appearances (screener_id, source, symbol, appeared_date, "
        "return_5d, return_10d, return_20d, return_60d, return_120d) "
        "VALUES ('scr1', 'trendlyne', 'EEE', ?, 2.0, 3.0, 4.0, 5.0, 6.0)",
        (appeared,),
    )
    conn.commit()
    filled = phase_b_fill_returns(CastStrippingConn(conn))
    assert filled == 0, "a fully-filled row must not be re-processed"


def test_phase_b_leaves_a_too_recent_row_alone():
    """A row that appeared only 3 days ago isn't even eligible for return_5d yet -- must not be
    selected at all (matches the pre-existing cutoff_5d behavior, unaffected by this fix)."""
    conn = make_db()
    appeared = (TODAY - datetime.timedelta(days=3)).isoformat()
    conn.execute(
        "INSERT INTO screener_appearances (screener_id, source, symbol, appeared_date) "
        "VALUES ('scr1', 'trendlyne', 'FFF', ?)",
        (appeared,),
    )
    conn.commit()
    _seed_ohlcv_run(conn, 'FFF', appeared, 10)
    filled = phase_b_fill_returns(CastStrippingConn(conn))
    assert filled == 0, "a 3-day-old appearance is too recent for even return_5d"
