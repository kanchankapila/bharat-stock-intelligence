"""
Point-in-time fundamentals: ml_ensemble.load_training_data must join the fundamentals that
were knowable on each signal_date (fundamentals_history as-of), never the current
stock_fundamentals snapshot. DB-backed, against real Postgres.

Converted off SQLite 2026-08-16 (SQLITE_DECOMMISSION_PLAN). The previous version built a temp
SQLite file and then tried to reconstruct production's technical_signals by PARSING ~160
`ALTER TABLE ... ADD COLUMN` statements out of db.sqlite-legacy.ts plus every *.py engine --
about 110 lines of regex whose only job was to approximate a schema this repo already has
written down. `pg_db_conn` applies db/schema.postgres.sql (generated from live) into a
throwaway schema, so the schema is exact by construction and the parser is gone. That parser
was also a live hazard in its own right: it read a sibling source file by hardcoded path
inside `except OSError: continue`, so renaming db.ts silently degraded the mock schema and
surfaced three files later as "no such column: ts.news_sentiment_score"
(see .claude/rules/recurring-bugs.md).
"""

import importlib
import os
import sys

import pandas as pd
import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)


def _seed(conn):
    """One resolved signal on 2024-06-01, plus a CURRENT stock_fundamentals snapshot claiming
    ROE=30 -- the post-hoc, leaky value each test below proves is NOT used."""
    # entry_price is NOT NULL in the real schema. The hand-rolled SQLite fixture this file used
    # to build omitted it entirely and happily stored the row -- one of the constraints that
    # only starts being enforced once the tests run against the actual production DDL.
    conn.execute(
        "INSERT INTO signal_outcomes "
        "(symbol, signal_date, horizon_days, entry_price, outcome, signal_score, signals_json, "
        " return_pct, signal_source) "
        "VALUES ('X','2024-06-01',15,100.0,'WIN',7,'[]',3.0,'technical')"
    )
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, rsi, nifty_regime, cmp, sma200) "
        "VALUES ('X','2024-06-01',55,'BULL',100,90)"
    )
    conn.execute(
        "INSERT INTO stock_fundamentals (symbol, return_on_equity, piotroski_f_score) "
        "VALUES ('X',30.0,9)"
    )
    conn.commit()


def _load():
    """Reload ml_ensemble so it binds to the throwaway schema pg_db_conn pinned POSTGRES_URL at,
    then run the real loader. No dialect override: this is the Postgres path, which is the only
    path production has."""
    import db_compat
    importlib.reload(db_compat)
    import sql_translate  # noqa: F401
    import ml_ensemble
    importlib.reload(ml_ensemble)
    return ml_ensemble.load_training_data()


def test_no_fundamentals_history_leaves_return_on_equity_null(pg_db_conn):
    """As of commit 66023a5 (2026-07-17, "close look-ahead bias leaks across the training
    pipeline"), load_training_data() no longer falls back to the CURRENT stock_fundamentals
    snapshot when a symbol has no fundamentals_history row as-of the signal date -- that
    fallback was the leak (it stamped today's fundamentals onto historical training rows).
    The correct, leak-free behaviour is to leave the fundamentals features NULL for that row
    rather than backfill them with post-hoc data; the model treats it as missing, which is
    honest."""
    _seed(pg_db_conn)
    df = _load()
    assert len(df) == 1
    assert df.iloc[0]["return_on_equity"] is None or pd.isna(df.iloc[0]["return_on_equity"])


def test_uses_as_of_snapshot_not_future_or_current(pg_db_conn):
    _seed(pg_db_conn)
    # History: ROE was 12 as-of 2024-05-15 (knowable on the signal date),
    # then 30 as-of 2024-07-01 (the future -- must NOT be selected).
    pg_db_conn.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) "
                       "VALUES ('X','2024-05-15',12.0)")
    pg_db_conn.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) "
                       "VALUES ('X','2024-07-01',30.0)")
    pg_db_conn.commit()
    df = _load()
    assert df.iloc[0]["return_on_equity"] == pytest.approx(12.0)  # as-of 2024-05-15, leak-free


def test_picks_latest_history_on_or_before_signal_date(pg_db_conn):
    _seed(pg_db_conn)
    pg_db_conn.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) "
                       "VALUES ('X','2024-03-01',10.0)")
    pg_db_conn.execute("INSERT INTO fundamentals_history (symbol,as_of_date,return_on_equity) "
                       "VALUES ('X','2024-05-20',15.0)")
    pg_db_conn.commit()
    df = _load()
    assert df.iloc[0]["return_on_equity"] == pytest.approx(15.0)  # latest <= signal_date
