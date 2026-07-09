"""
Point-in-time fundamentals: ml_ensemble.load_training_data must join the fundamentals that
were knowable on each signal_date (fundamentals_history as-of), falling back to the current
stock_fundamentals snapshot only when no history has accumulated. DB-backed (temp SQLite).
"""

import importlib
import os
import re
import sqlite3
import sys
import tempfile

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

# Ensure .env is loaded (sets USE_POSTGRES in os.environ) before any test pops it.
# Without this, the first call to `import db_compat` inside _load() would load .env
# AFTER the pop, re-setting USE_POSTGRES=true and defeating the SQLite redirect.
import db_compat as _db_compat_preload  # noqa: F401, E402


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


def _technical_signals_alter_statements():
    """load_training_data()'s SQLite branch selects ~160 technical_signals columns that
    only exist via ALTER TABLE ADD COLUMN migrations -- most in db.ts, but some are
    self-migrated by individual Python engines instead (e.g. mc_corporate_calendar_fetcher.py,
    bse_event_classifier.py). Hand-copying either list here would drift out of sync on every
    new migration (exactly what caused this test to start failing) -- parse both db.ts and
    every *.py engine for their ADD COLUMN statements, so the mock schema always matches
    whatever columns actually exist in production, wherever they're defined.

    "IF NOT EXISTS" is stripped since SQLite's ALTER TABLE doesn't support it (the Postgres-only
    variant some engines hardcode) -- duplicates across sources are handled by _make_db()'s
    per-statement try/except, not de-duped here.
    """
    sources = [os.path.join(SERVER_DIR, "db.ts")]
    sources += [
        os.path.join(SERVER_DIR, f) for f in os.listdir(SERVER_DIR) if f.endswith(".py")
    ]
    # Only the column name + a single-word type is needed (SQLite type affinity doesn't
    # care about DOUBLE PRECISION vs REAL, and any trailing DEFAULT/constraint clause is
    # irrelevant to this test) -- so match just past the type keyword and stop.
    literal_pattern = re.compile(
        r"ALTER TABLE technical_signals ADD COLUMN(?: IF NOT EXISTS)? +([a-zA-Z_0-9]+) +([A-Za-z]+)"
    )
    # A couple of engines build the ALTER via an f-string over a Python list of column
    # definitions (e.g. `for col, dtype in _TECHNICAL_SIGNALS_COLS:`) instead of a literal
    # string -- literal_pattern can't see the real column name in those cases (it matches
    # the f-string's static text up to "{...}" and misfires). Catch the two list-literal
    # shapes actually used: [("col", "TYPE"), ...] and ["col   TYPE", ...].
    tuple_list_pattern = re.compile(r'\(\s*"([a-zA-Z_0-9]+)"\s*,\s*"([A-Za-z]+)"\s*\)')
    string_list_pattern = re.compile(r'"([a-zA-Z_0-9]+)\s+([A-Za-z]+)"')

    statements = []
    for path in sources:
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        for col, coltype in literal_pattern.findall(text):
            if col.upper() in ("IF", "NOT", "EXISTS"):  # f-string {var} defeated the match
                continue
            statements.append(f"ALTER TABLE technical_signals ADD COLUMN {col} {coltype}")
        basename = os.path.basename(path)
        if basename == "stock_option_chain_fetcher.py":
            for col, coltype in tuple_list_pattern.findall(text):
                statements.append(f"ALTER TABLE technical_signals ADD COLUMN {col} {coltype}")
        if basename == "screener_features_fetcher.py":
            cols_block = re.search(r"^COLS = \[(.*?)^\]", text, re.MULTILINE | re.DOTALL)
            if cols_block:
                for col, coltype in string_list_pattern.findall(cols_block.group(1)):
                    statements.append(f"ALTER TABLE technical_signals ADD COLUMN {col} {coltype}")
    return statements


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
            insider_buy_pct_90d REAL,
            opening_range_break REAL, vwap_deviation_pct REAL, first_hour_vol_share REAL,
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
        CREATE TABLE analyst_estimates_history (
            symbol TEXT NOT NULL, as_of_date TEXT NOT NULL, n_analysts INTEGER,
            final_rating TEXT, buy_count INTEGER, hold_count INTEGER, sell_count INTEGER,
            target_high REAL, target_mean REAL, target_low REAL,
            eps_est_next REAL, revenue_est_next REAL, captured_at TEXT,
            PRIMARY KEY (symbol, as_of_date)
        );
        CREATE TABLE proprietary_scores_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
            score_type TEXT NOT NULL, score_value REAL,
            PRIMARY KEY (symbol, date, source, score_type)
        );
        CREATE TABLE insider_trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, acquirerName TEXT, category TEXT,
            typeOfTransaction TEXT, quantity BIGINT, valueInr REAL, date TEXT
        );
        CREATE TABLE intraday_ohlcv (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, datetime TEXT, open REAL, high REAL, low REAL,
            close REAL, volume REAL, vwap REAL, interval TEXT
        );
        CREATE TABLE nse_stocks (
            symbol TEXT PRIMARY KEY,
            name TEXT,
            sector TEXT
        );
        CREATE TABLE mc_sector_earnings (
            sector_name TEXT PRIMARY KEY,
            np_growth_yoy REAL,
            np_growth_qoq REAL,
            rev_growth_yoy REAL
        );
        CREATE TABLE sector_fo_sentiment (
            sector TEXT,
            date TEXT,
            sector_pcr REAL,
            total_call_oi REAL,
            total_put_oi REAL,
            PRIMARY KEY (sector, date)
        );
        CREATE TABLE feature_store (
            symbol TEXT,
            date TEXT,
            timeframe TEXT,
            ret_12m_ex1m REAL,
            PRIMARY KEY (symbol, date, timeframe)
        );
        CREATE TABLE historical_fno_sentiment (
            symbol TEXT,
            date TEXT,
            max_pain REAL,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE credit_rating_events (
            symbol TEXT,
            announcement_date TEXT,
            action TEXT
        );
    """)
    # Bring technical_signals up to the real production schema (base CREATE TABLE above
    # plus every ADD COLUMN migration in db.ts) -- see _technical_signals_alter_statements.
    for stmt in _technical_signals_alter_statements():
        try:
            con.execute(stmt)
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
    con.commit()
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
