"""
Point-in-time fundamentals: ml_ensemble.load_training_data must join the fundamentals that
were knowable on each signal_date (fundamentals_history as-of), falling back to the current
stock_fundamentals snapshot only when no history has accumulated. DB-backed (temp SQLite).
"""

import importlib
import os
import sqlite3
import sys
import tempfile

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)


@pytest.fixture(autouse=True)
def _restore_db_env():
    """These tests repoint DATABASE_URL at a temp SQLite. Restore it (and reset the db_compat
    engine cache) afterwards so later test modules don't inherit our throwaway DB."""
    saved = {k: os.environ.get(k) for k in ("DATABASE_URL", "USE_POSTGRES")}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    import importlib
    import db_compat
    importlib.reload(db_compat)


def _make_db():
    path = os.path.join(tempfile.mkdtemp(), "pit_test.sqlite")
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INT, outcome TEXT,
            signal_score INT, signals_json TEXT, return_pct REAL,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, rsi REAL, adx REAL, nifty_regime TEXT, cmp REAL,
            sma200 REAL, volume_ratio REAL, fii_3d_net REAL, above_sma200 INT,
            pcr_oi REAL, pcr_vol REAL, fii_10d_net REAL, dii_3d_net REAL, delivery_pct REAL,
            sector_ret_5d REAL, sector_ret_21d REAL, iv_rank REAL, iv_skew REAL,
            rs_rank_21d REAL, rs_rank_63d REAL,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_fundamentals (
            symbol TEXT PRIMARY KEY, fifty_two_week_high REAL, piotroski_f_score INT,
            debt_to_equity REAL, operating_margins REAL, return_on_equity REAL,
            revenue_growth REAL, earnings_growth REAL, earnings_yield REAL,
            price_to_book REAL, market_cap REAL
        );
        CREATE TABLE fundamentals_history (
            symbol TEXT, as_of_date TEXT, fifty_two_week_high REAL, piotroski_f_score INT,
            debt_to_equity REAL, operating_margins REAL, return_on_equity REAL,
            revenue_growth REAL, earnings_growth REAL, earnings_yield REAL,
            price_to_book REAL, market_cap REAL, captured_at TEXT,
            PRIMARY KEY (symbol, as_of_date)
        );
        CREATE TABLE macro_asset_prices (
            date TEXT, symbol TEXT, close REAL, ret_1d REAL, ret_5d REAL,
            PRIMARY KEY (date, symbol)
        );
        CREATE TABLE market_breadth (
            date TEXT PRIMARY KEY, pct_above_200dma REAL, adv_decline_ratio REAL,
            pct_at_20d_high REAL, net_highs_lows REAL, computed_at TEXT
        );
    """)
    # One signal on 2024-06-01 (resolved WIN).
    con.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome,signal_score,signals_json,return_pct) "
                "VALUES ('X','2024-06-01',15,'WIN',7,'[]',3.0)")
    con.execute("INSERT INTO technical_signals (symbol,date,rsi,nifty_regime,cmp,sma200) "
                "VALUES ('X','2024-06-01',55,'BULL',100,90)")
    # CURRENT snapshot says ROE=30 (the post-hoc, leaky value).
    con.execute("INSERT INTO stock_fundamentals (symbol,return_on_equity,piotroski_f_score) VALUES ('X',30.0,9)")
    con.commit()
    return path, con


def _load(path):
    os.environ.pop("USE_POSTGRES", None)
    os.environ["DATABASE_URL"] = f"sqlite:///{path}"
    import db_compat
    importlib.reload(db_compat)
    import sql_translate  # noqa: F401
    import ml_ensemble
    importlib.reload(ml_ensemble)
    return ml_ensemble.load_training_data()


def test_falls_back_to_current_snapshot_when_no_history():
    path, con = _make_db()
    try:
        df = _load(path)
        assert len(df) == 1
        assert df.iloc[0]["return_on_equity"] == pytest.approx(30.0)  # current snapshot fallback
    finally:
        con.close()


def test_uses_as_of_snapshot_not_future_or_current():
    path, con = _make_db()
    try:
        # History: ROE was 12 as-of 2024-05-15 (knowable on the signal date),
        # then 30 as-of 2024-07-01 (the future — must NOT be selected).
        con.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) VALUES ('X','2024-05-15',12.0)")
        con.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) VALUES ('X','2024-07-01',30.0)")
        con.commit()
        df = _load(path)
        assert df.iloc[0]["return_on_equity"] == pytest.approx(12.0)  # as-of 2024-05-15, leak-free
    finally:
        con.close()


def test_picks_latest_history_on_or_before_signal_date():
    path, con = _make_db()
    try:
        con.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) VALUES ('X','2024-03-01',10.0)")
        con.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) VALUES ('X','2024-05-20',15.0)")
        con.commit()
        df = _load(path)
        assert df.iloc[0]["return_on_equity"] == pytest.approx(15.0)  # latest ≤ signal_date
    finally:
        con.close()
