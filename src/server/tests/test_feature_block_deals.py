"""
Tests for _merge_block_deals (2026-09-13).

feature_store.block_deal_net_qty was 0.03% populated: the old join read
technical_signals, whose block_deal_* columns are stamped only by
block_deal_fetcher.backfill_technical_signals() for that script's run date.
_merge_block_deals reads block_deals -- the table of record -- directly, hole-fills
net_qty (NEVER clobbering an upstream technical_signals value), and adds
block_deal_value_cr (already consumed by ml_ensemble, previously always-defaulting
to 0.0), plus trailing 5-session sums for net qty and value.
"""

import os
import sys
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import src.server.feature_engineering as fe_mod  # noqa: E402
from src.server.feature_engineering import FeatureEngineer  # noqa: E402
from test_feature_engineering_batch import (  # noqa: E402
    _FEATURE_STORE_DDL as _FULL_FEATURE_STORE_DDL,
)

_FEATURE_STORE_DDL = """
CREATE TABLE IF NOT EXISTS feature_store (
    symbol TEXT, date TEXT, timeframe TEXT,
    block_deal_net_qty REAL, block_deal_value_cr REAL,
    block_deal_net_qty_5d REAL, block_deal_value_cr_5d REAL,
    computed_at TEXT,
    PRIMARY KEY (symbol, date, timeframe)
)
"""
_OHLCV_DDL = """
CREATE TABLE IF NOT EXISTS stock_ohlcv (
    symbol TEXT, date DATE, open REAL, high REAL, low REAL, close REAL, volume REAL,
    is_suspect INTEGER DEFAULT 0
)
"""
_BLOCK_DEALS_DDL = """
CREATE TABLE IF NOT EXISTS block_deals (
    id TEXT PRIMARY KEY, symbol TEXT, date TEXT, session TEXT,
    qty BIGINT, price REAL, value_cr REAL, fetched_at TEXT,
    pct_transacted REAL, client_name TEXT, trade_type TEXT,
    category TEXT, source TEXT
)
"""

# 10 recent calendar dates. The merge tests use this index directly; the
# full-pipeline test seeds a 60-row OHLCV window (process_symbol's guard).
DATES = pd.date_range(end=pd.Timestamp.today().normalize(), periods=10, freq="D")
D = [d.strftime("%Y-%m-%d") for d in DATES]

_MERGE_COLS = ["date", "buy_qty", "sell_qty", "net_qty", "value_cr", "deal_count"]


def _make_db(symbol: str, deals: list):
    """Sandbox with feature_store + stock_ohlcv (60 rows) + block_deals.

    deals: (date_index, qty, value_cr, trade_type, session) tuples.
    """
    con = pg_memory_conn()
    con.execute(_FEATURE_STORE_DDL)
    con.execute(_OHLCV_DDL)
    con.execute(_BLOCK_DEALS_DDL)
    ohlcv_dates = pd.date_range(end=pd.Timestamp.today().normalize(), periods=60, freq="D")
    con.executemany(
        "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
        [(symbol, d.strftime("%Y-%m-%d"), 100.0, 105.0, 95.0, 100.0, 1e6) for d in ohlcv_dates],
    )
    for i, (di, qty, val, ttype, sess) in enumerate(deals):
        con.execute(
            "INSERT INTO block_deals (id, symbol, date, session, qty, price, value_cr,"
            " trade_type, source) VALUES (?,?,?,?,?,?,?,?,?)",
            (f"{symbol}-{i}", symbol, D[di], sess, qty, 100.0, val, ttype, "tickertape"),
        )
    con.commit()
    return con

def _feat(with_upstream: bool = True) -> pd.DataFrame:
    """feat indexed on DATES; block_deal_net_qty pre-set as _merge_flow_features would
    leave it -- all NaN except one upstream technical_signals value on D[2]."""
    feat = pd.DataFrame(index=DATES)
    feat["block_deal_net_qty"] = np.nan
    if with_upstream:
        feat.loc[DATES[2], "block_deal_net_qty"] = 5.0
    return feat


_MERGE_COLS = ["date", "buy_qty", "sell_qty", "net_qty", "value_cr", "deal_count"]


def _merge(con, feat, symbol="TEST"):
    """Run the real merge with feature_engineering.read_df pointed at the sandbox."""

    def _read(sql, params=()):
        res = con.execute(sql, params)
        return pd.DataFrame(res.fetchall(), columns=_MERGE_COLS)

    with patch.object(fe_mod, "read_df", _read):
        return FeatureEngineer()._merge_block_deals(feat, symbol)

class TestBlockDealMerge:

    def test_trade_type_side_and_net(self):
        """buy 100 @ 2.0cr + sell 30 @ 0.6cr on D[0] -> net 70, value 2.6."""
        con = _make_db("TEST", [(0, 100, 2.0, "buy", None), (0, 30, 0.6, "sell", None)])
        out = _merge(con, _feat())
        assert out.loc[DATES[0], "block_deal_net_qty"] == 70
        assert out.loc[DATES[0], "block_deal_value_cr"] == pytest.approx(2.6)

    def test_session1_fallback_is_buy(self):
        """trade_type-NULL rows (the NSE source) fall back to the session rule."""
        con = _make_db("TEST", [(1, 50, 1.0, None, "Session 1"),
                                (2, 20, 0.4, None, "Session 2")])
        out = _merge(con, _feat(with_upstream=False))
        # D[1]: Session 1 -> buy -> +50. D[2]: Session 2 -> sell -> -20.
        assert out.loc[DATES[1], "block_deal_net_qty"] == 50
        assert out.loc[DATES[2], "block_deal_net_qty"] == -20

    def test_hole_fill_never_clobbers_upstream(self):
        """D[2] has an upstream technical_signals value (5.0) AND deals -- the upstream
        value wins (hole-fill only). D[0] has no upstream value -> filled from deals."""
        con = _make_db("TEST", [(0, 100, 2.0, "buy", None), (2, 500, 5.0, "sell", None)])
        out = _merge(con, _feat())
        assert out.loc[DATES[0], "block_deal_net_qty"] == 100
        assert out.loc[DATES[2], "block_deal_net_qty"] == 5.0

    def test_no_deals_all_nan(self):
        """A symbol with no deals leaves every column NaN -- NEVER_FILL."""
        con = _make_db("TEST", [])
        out = _merge(con, _feat(with_upstream=False))
        for col in ("block_deal_net_qty", "block_deal_value_cr",
                    "block_deal_net_qty_5d", "block_deal_value_cr_5d"):
            assert out[col].isna().all(), col

    def test_rolling_5_session_window(self):
        """net_qty_5d on D[k] = sum of deal-day nets in DATES[k-4..k]; a window with no
        deal days is NaN (min_periods=1), not zero."""
        con = _make_db("TEST", [(0, 100, 2.0, "buy", None), (1, 50, 1.0, "buy", None),
                                (4, 10, 0.3, "sell", None)])
        out = _merge(con, _feat(with_upstream=False))
        assert out.loc[DATES[0], "block_deal_net_qty_5d"] == 100
        assert out.loc[DATES[1], "block_deal_net_qty_5d"] == 150
        assert out.loc[DATES[5], "block_deal_net_qty_5d"] == 40
        assert np.isnan(out.loc[DATES[9], "block_deal_net_qty_5d"])
        assert out.loc[DATES[1], "block_deal_value_cr_5d"] == pytest.approx(3.0)

    def test_full_pipeline_writes_new_columns(self):
        """process_symbol persists the new columns into feature_store."""
        con = _make_db("TEST", [(0, 100, 2.0, "buy", None)])
        con.execute("DROP TABLE feature_store")
        con.execute(_FULL_FEATURE_STORE_DDL)
        con.commit()
        fe = FeatureEngineer()
        fe._merge_fii = lambda feat: feat
        fe._merge_fundamentals = lambda feat, sym: feat
        fe._merge_macro = lambda feat: feat
        fe._merge_sentiment = lambda feat, sym: feat
        fe._merge_flow_features = lambda feat, sym: feat
        fe._merge_deep_history = lambda feat, sym: feat
        fe._merge_market_context = lambda feat: feat

        def _read(sql, params=()):
            res = con.execute(sql, params)
            return pd.DataFrame(res.fetchall(), columns=_MERGE_COLS)

        with patch.object(fe_mod, "read_df", _read):
            n = fe.process_symbol("TEST", con=con)
        assert n > 0
        row = con.execute(
            "SELECT block_deal_net_qty, block_deal_value_cr, block_deal_net_qty_5d,"
            " block_deal_value_cr_5d FROM feature_store"
            " WHERE symbol='TEST' AND date=?", (D[0],)
        ).fetchone()
        assert row[0] == 100
        assert row[1] == pytest.approx(2.0)
        assert row[2] == 100
        assert row[3] == pytest.approx(2.0)
        null_row = con.execute(
            "SELECT block_deal_value_cr FROM feature_store"
            " WHERE symbol='TEST' AND date=?", (D[5],)
        ).fetchone()
        assert null_row[0] is None

        # Regression guard (2026-09-13): the ON CONFLICT DO UPDATE SET list is a THIRD
        # column enumeration in this file. When it lags behind the INSERT lists, a
        # re-write of an existing row silently leaves the new columns NULL -- exactly
        # how block_deal_value_cr/_5d stayed NULL in production on the first live run.
        with patch.object(fe_mod, "read_df", _read):
            fe.process_symbol("TEST", con=con)
        row2 = con.execute(
            "SELECT block_deal_net_qty, block_deal_value_cr FROM feature_store"
            " WHERE symbol='TEST' AND date=?", (D[0],)
        ).fetchone()
        assert row2[0] == 100
        assert row2[1] == pytest.approx(2.0)
