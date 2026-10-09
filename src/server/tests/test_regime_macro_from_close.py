"""AF-20261008 sub-project B.1: regime_detector macro 5-day returns.

Default (flag `regime_macro_ret_from_close` absent/off) must stay bit-identical to the stored
`ret_5d` path with NULLs filled 0. Flag on computes the return from the close series instead.
"""
import os
import sys
from datetime import date, timedelta
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
import src.server.regime_detector as rd  # noqa: E402

MACRO = [("US10Y", "us10y_chg5d"), ("DXY", "dxy_ret_5d"), ("SP500", "sp500_ret_5d")]
DATES = [(date(2024, 4, 1) + timedelta(days=i)).isoformat() for i in range(60)]


def _conn(flag=None, with_app_settings=True):
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, close REAL)")
    conn.execute("CREATE TABLE fii_dii_flow (date TEXT, fii_net REAL)")
    conn.execute("CREATE TABLE macro_asset_prices (symbol TEXT, date DATE, close REAL, ret_5d REAL)")
    conn.execute("CREATE TABLE market_breadth (date TEXT, adv_decline_ratio REAL)")
    if with_app_settings:
        conn.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)")
        if flag is not None:
            conn.execute("INSERT INTO app_settings VALUES ('regime_macro_ret_from_close', ?)", (flag,))
    for i, d in enumerate(DATES):
        conn.execute("INSERT INTO stock_ohlcv VALUES ('NIFTY50', ?, ?)", (d, 21000.0 + 10 * i))
        for k, (sym, _) in enumerate(MACRO):
            # ret_5d stored only on even days (the NULL-hole shape), and deliberately NOT the
            # close-derived value, so the two paths are distinguishable.
            conn.execute("INSERT INTO macro_asset_prices VALUES (?,?,?,?)",
                         (sym, d, 100.0 + k + i * 0.5, 0.123 if i % 2 == 0 else None))
    conn.commit()
    return conn


def _read(conn):
    return lambda sql, params=(): pd.read_sql_query(sql, conn, params=tuple(params))


def _load(conn, **kw):
    with patch.object(rd, 'read_df', _read(conn)):
        return rd._load_hmm_features(lookback_days=40, as_of_date=DATES[-1], **kw)


def test_flag_off_is_todays_stored_ret5d_fill_zero():
    for conn in (_conn(), _conn(flag='false'), _conn(with_app_settings=False)):
        df = _load(conn)
        assert not df.empty
        for _, col in MACRO:
            assert set(np.round(df[col].unique(), 6)) <= {0.0, 0.123}
            assert (df[col] == 0.0).any() and (df[col] == 0.123).any()


def test_flag_on_computes_from_close():
    conn = _conn(flag='true')
    df = _load(conn)
    for k, (sym, col) in enumerate(MACRO):
        closes = pd.Series([100.0 + k + i * 0.5 for i in range(len(DATES))],
                           index=pd.to_datetime(DATES), dtype='float32').astype(float)
        expected = closes.pct_change(5).reindex(df.index)
        assert np.allclose(df[col].values, expected.values, rtol=1e-5)
        assert not (df[col] == 0.0).any()


def test_zero_fill_report_counts_filled_rows():
    off = None
    with patch.object(rd, 'read_df', _read(_conn())):
        off = rd.zero_fill_report(lookback_days=40, as_of_date=DATES[-1])
    with patch.object(rd, 'read_df', _read(_conn(flag='true'))):
        on = rd.zero_fill_report(lookback_days=40, as_of_date=DATES[-1])
    assert off['rows'] == on['rows'] > 0
    for _, col in MACRO:
        assert off[col] > 0          # odd days were zero-filled
        assert on[col] == 0          # warm-up window covers the first 5 closes


def _regimes_conn(with_backfilled):
    conn = pg_memory_conn()
    extra = ", backfilled BOOLEAN" if with_backfilled else ""
    conn.execute(f"""CREATE TABLE market_regimes (date TEXT PRIMARY KEY, regime TEXT,
        regime_prob REAL, hmm_state INTEGER, viterbi_path_json TEXT, features_json TEXT,
        computed_at TIMESTAMP{extra})""")
    conn.commit()
    return conn


class _M:
    def predict(self, X): return np.zeros(len(X), dtype=int)
    def predict_proba(self, X): return np.tile([1.0, 0, 0, 0, 0], (len(X), 1))


class _S:
    def transform(self, X): return X.values


@pytest.mark.parametrize("with_col", [False, True])
def test_backfilled_marker_written_only_if_column_exists(with_col):
    conn = _regimes_conn(with_col)
    feats = pd.DataFrame({'a': [1.0]}, index=pd.to_datetime(['2024-05-01']))

    def _exec(sql, params=()):
        conn.execute(sql, params)
        conn.commit()

    with patch.object(rd, 'read_df', _read(conn)), patch.object(rd, 'execute', _exec), \
            patch.object(rd, '_load_hmm_features', lambda lookback_days, as_of_date: feats):
        has = rd._has_column('market_regimes', 'backfilled')
        assert has is with_col
        rd._label_day(_M(), _S(), {0: 'BULL'}, '2024-05-01', publish_live=False,
                      backfilled=True if has else None)
    row = pd.read_sql_query("SELECT * FROM market_regimes", conn).iloc[0]
    assert row['regime'] == 'BULL'
    if with_col:
        assert bool(row['backfilled']) is True
    else:
        assert 'backfilled' not in row.index


def test_retrain_standalone_raises_on_error(monkeypatch):
    monkeypatch.setattr(rd, 'train_hmm', lambda force=False: {"error": "Only 3 rows"})
    with pytest.raises(RuntimeError):
        rd.retrain_standalone()
    monkeypatch.setattr(rd, 'train_hmm', lambda force=False: {"promotion": {"promoted": True}})
    assert rd.retrain_standalone()["promotion"]["promoted"] is True
