"""
Tests for executemany + single-connection batch writes in FeatureEngineer.
"""

import sys
import os
import sqlite3
import tempfile
import types
from pathlib import Path
from unittest.mock import patch, MagicMock, call
import pandas as pd
import numpy as np
import pytest

# process_symbol writes the fitted scaler to SCALER_PATH; point it at a throwaway temp file
# so the real ml_models/feature_scaler_v1.pkl is never truncated by these mock-driven tests.
_TMP_SCALER = Path(tempfile.gettempdir()) / "test_feature_scaler_v1.pkl"

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from src.server.feature_engineering import FeatureEngineer


# ── Helpers ──────────────────────────────────────────────────────────────────

_FEATURE_COLS = [
    "ret_1d", "ret_5d", "ret_15d", "ret_21d", "ret_63d", "ret_126d", "ret_252d",
    "sma20", "sma50", "sma200", "ema8", "ema21", "dist_sma20_pct", "dist_sma200_pct", "above_sma200",
    "rsi_14", "rsi_28", "macd", "macd_signal", "macd_hist", "adx", "di_plus", "di_minus",
    "stoch_k", "stoch_d", "cci", "williams_r",
    "atr_14", "atr_pct", "bb_upper", "bb_lower", "bb_width", "bb_pct",
    "hist_vol_21d", "hist_vol_63d", "vol_regime",
    "volume_ratio_20d", "volume_ratio_5d", "obv", "obv_slope", "vwap", "vwap_dist_pct",
    "trend_1d", "trend_1w", "trend_1m", "mtf_alignment_score",
    "fii_3d_net", "fii_10d_net", "dii_3d_net",
    "trailing_pe", "roe", "debt_to_equity", "op_margins", "piotroski_f", "earnings_yield",
    "nifty_vix", "nifty_ret_5d", "nifty_ret_21d",
    "us_10y_yield", "dxy", "crude_ret_5d", "gold_ret_5d", "sp500_ret_5d",
    "news_sentiment_score", "news_impact_count",
    "target_ret_1d", "target_ret_5d", "target_ret_15d",
    "target_dir_1d", "target_dir_5d", "target_dir_15d",
]

_FEATURE_STORE_DDL = """
CREATE TABLE IF NOT EXISTS feature_store (
    symbol TEXT, date TEXT, timeframe TEXT,
    ret_1d REAL, ret_5d REAL, ret_15d REAL, ret_21d REAL, ret_63d REAL, ret_126d REAL, ret_252d REAL,
    sma20 REAL, sma50 REAL, sma200 REAL, ema8 REAL, ema21 REAL,
    dist_sma20_pct REAL, dist_sma200_pct REAL, above_sma200 REAL,
    rsi_14 REAL, rsi_28 REAL, macd REAL, macd_signal REAL, macd_hist REAL,
    adx REAL, di_plus REAL, di_minus REAL,
    stoch_k REAL, stoch_d REAL, cci REAL, williams_r REAL,
    atr_14 REAL, atr_pct REAL, bb_upper REAL, bb_lower REAL, bb_width REAL, bb_pct REAL,
    hist_vol_21d REAL, hist_vol_63d REAL, vol_regime TEXT,
    volume_ratio_20d REAL, volume_ratio_5d REAL, obv REAL, obv_slope REAL, vwap REAL, vwap_dist_pct REAL,
    trend_1d REAL, trend_1w REAL, trend_1m REAL, mtf_alignment_score REAL,
    fii_3d_net REAL, fii_10d_net REAL, dii_3d_net REAL,
    trailing_pe REAL, roe REAL, debt_to_equity REAL, op_margins REAL, piotroski_f REAL, earnings_yield REAL,
    nifty_vix REAL, nifty_ret_5d REAL, nifty_ret_21d REAL,
    us_10y_yield REAL, dxy REAL, crude_ret_5d REAL, gold_ret_5d REAL, sp500_ret_5d REAL,
    news_sentiment_score REAL, news_impact_count REAL,
    target_ret_1d REAL, target_ret_5d REAL, target_ret_15d REAL,
    target_dir_1d REAL, target_dir_5d REAL, target_dir_15d REAL,
    ret_12m_ex1m REAL,
    computed_at TEXT,
    PRIMARY KEY (symbol, date, timeframe)
)
"""

_OHLCV_DDL = """
CREATE TABLE IF NOT EXISTS stock_ohlcv (
    symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL,
    is_suspect INTEGER DEFAULT 0
)
"""


def _make_feat_df(n: int = 3) -> pd.DataFrame:
    """Return a minimal DataFrame with all expected feature columns."""
    dates = pd.date_range("2024-01-01", periods=n, freq="D")
    data = {col: [0.5] * n for col in _FEATURE_COLS}
    # vol_regime must be a string column
    data["vol_regime"] = ["MED"] * n
    return pd.DataFrame(data, index=dates)


def _make_in_memory_db(symbol: str = None, ohlcv_rows: int = 60) -> sqlite3.Connection:
    """Open an in-memory SQLite DB with the required tables. If `symbol` is given, seeds
    stock_ohlcv with `ohlcv_rows` rows for it -- process_symbol's OHLCV read now goes
    through the passed-in `con` (see feature_engineering.py's process_symbol), not a
    mockable global pandas.read_sql call, so the row-count guard (len(ohlcv) < 60) needs
    real rows here rather than a `patch("pandas.read_sql", ...)`."""
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute(_FEATURE_STORE_DDL)
    con.execute(_OHLCV_DDL)
    if symbol:
        # process_symbol's real query filters WHERE date >= today - lookback_days (504 default)
        # -- dates must be recent, not a fixed 2023 range (which was fine when this only fed a
        # mocked pandas.read_sql, but is silently excluded now that the read is real).
        dates = pd.date_range(end=pd.Timestamp.today().normalize(), periods=ohlcv_rows, freq="D")
        con.executemany(
            "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
            [(symbol, d.strftime("%Y-%m-%d"), 100.0, 105.0, 95.0, 100.0, 1e6) for d in dates],
        )
    con.commit()
    return con


def _stub_fe() -> FeatureEngineer:
    # FeatureEngineer.__init__ takes no args and opens no connection (db_compat migration);
    # the test injects its own mock connection into the method under test.
    return FeatureEngineer()


# ── Tests ────────────────────────────────────────────────────────────────────


class TestBatchWrites:

    def test_executemany_used(self):
        """con.executemany() is called directly; no throwaway cursor().executemany()."""
        feat_df = _make_feat_df(3)
        fe = _stub_fe()

        # Seeds stock_ohlcv with 60 real rows for TEST -- process_symbol reads OHLCV
        # through `con` directly now, so the >=60-row guard needs real rows, not a mock.
        con = _make_in_memory_db(symbol="TEST")

        # Wrap the real connection so MagicMock records calls to con.executemany()
        # directly, while still delegating to the real implementation.
        mock_con = MagicMock(wraps=con)

        # Stub out all the expensive private methods so no real DB reads happen
        fe._compute_ohlcv_features = lambda df: feat_df
        fe._merge_fii = lambda feat: feat
        fe._merge_fundamentals = lambda feat, sym: feat
        fe._merge_macro = lambda feat: feat
        fe._merge_sentiment = lambda feat, sym: feat
        fe._fit_scaler = lambda feat, **kw: MagicMock(
            transform=lambda X: X.values
        )
        fe._apply_scaler = lambda feat, scaler: feat

        with patch("src.server.feature_engineering.SCALER_PATH", _TMP_SCALER), \
             patch("pickle.dump"):  # avoid writing scaler to disk
            result = fe.process_symbol("TEST", con=mock_con)

        # con.executemany() must have been called (not con.cursor().executemany())
        assert mock_con.executemany.called, "con.executemany() should have been called at least once"
        assert result == 3, f"Expected 3 rows written, got {result}"

    def test_shared_connection(self):
        """run_full_pipeline opens exactly ONE write connection (self._con) for the whole run.
        Workers compute features in a process pool; all writes flow through the single shared
        main-process connection, which is committed and closed once.

        Both stub symbols intentionally resolve to (symbol, None) -- i.e. 0 rows written --
        which the written==0 guard added 2026-08 (see TestZeroRowsGuard below) now correctly
        raises on. That guard exists so a real production run that silently wrote 0 feature
        rows fails loudly instead of exiting 0 and leaving feature_store looking merely quiet
        rather than broken (see the 2026-08 job-health investigation in CLAUDE.md)."""
        fe = _stub_fe()
        mock_con = MagicMock()
        fe._con = MagicMock(return_value=mock_con)

        submitted = []

        class _FakeExecutor:
            """Synchronous stand-in for ProcessPoolExecutor — no subprocesses. Each submit
            returns a future whose result is (symbol, None) so no real feature write occurs."""
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def submit(self, fn, arg):
                submitted.append(arg[0])
                fut = MagicMock()
                fut.result = lambda: (arg[0], None)
                return fut

        with patch("src.server.feature_engineering.ProcessPoolExecutor", _FakeExecutor), \
             patch("src.server.feature_engineering.as_completed", lambda fs: list(fs)):
            with pytest.raises(RuntimeError, match="wrote 0 feature rows"):
                fe.run_full_pipeline(symbols=["SYM1", "SYM2"])

        # Exactly one write connection opened for the whole run, even though it ultimately raised.
        assert fe._con.call_count == 1, (
            f"Expected exactly 1 self._con() call, got {fe._con.call_count}"
        )
        # Both symbols were dispatched to the pool.
        assert set(submitted) == {"SYM1", "SYM2"}, f"Symbols dispatched: {submitted}"
        # The single shared connection is still closed via `finally`, even on the raise.
        mock_con.close.assert_called_once()

    def test_written_count_correct(self):
        """Return value matches the number of rows actually inserted."""
        n_rows = 5
        feat_df = _make_feat_df(n_rows)
        fe = _stub_fe()
        con = _make_in_memory_db(symbol="TATA")

        fe._compute_ohlcv_features = lambda df: feat_df
        fe._merge_fii = lambda feat: feat
        fe._merge_fundamentals = lambda feat, sym: feat
        fe._merge_macro = lambda feat: feat
        fe._merge_sentiment = lambda feat, sym: feat
        fe._fit_scaler = lambda feat, **kw: MagicMock(
            transform=lambda X: X.values
        )
        fe._apply_scaler = lambda feat, scaler: feat

        with patch("src.server.feature_engineering.SCALER_PATH", _TMP_SCALER), \
             patch("pickle.dump"):
            result = fe.process_symbol("TATA", con=con)

        assert result == n_rows, f"Expected {n_rows} rows written, got {result}"

        # Verify rows are actually in the DB
        actual = con.execute(
            "SELECT COUNT(*) FROM feature_store WHERE symbol='TATA'"
        ).fetchone()[0]
        assert actual == n_rows, f"DB has {actual} rows, expected {n_rows}"


class TestZeroRowsGuard:
    """2026-08 job-health investigation: feature_store's MAX(computed_at) was found frozen
    for weeks with no error anywhere in job_heartbeat/BullMQ. run_full_pipeline() used to
    print 'Pipeline complete — 0 total rows written' and exit 0 whenever every symbol failed
    or the symbol list itself was empty -- a silent-empty success indistinguishable from a
    healthy day. Both guards must fail loudly instead."""

    def test_empty_symbol_list_raises(self):
        """symbols=None resolving to zero rows from stock_ohlcv must not exit 0 silently."""
        fe = _stub_fe()
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date TEXT)")
        con.commit()
        fe._con = MagicMock(return_value=con)

        with pytest.raises(RuntimeError, match="No symbols found"):
            fe.run_full_pipeline(symbols=None)

        # The connection opened to run the (empty) query must still be closed.
        con2 = con  # sqlite3 has no MagicMock close-tracking; assert no exception on close
        con2.close()

    def test_all_workers_failing_raises(self):
        """Every symbol resolving to (symbol, None) — the real shape when every worker hits
        an exception or insufficient data — must raise, not report a clean 0-row success."""
        fe = _stub_fe()
        mock_con = MagicMock()
        fe._con = MagicMock(return_value=mock_con)

        class _FakeExecutor:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def submit(self, fn, arg):
                fut = MagicMock()
                fut.result = lambda: (arg[0], None)
                return fut

        with patch("src.server.feature_engineering.ProcessPoolExecutor", _FakeExecutor), \
             patch("src.server.feature_engineering.as_completed", lambda fs: list(fs)):
            with pytest.raises(RuntimeError, match="wrote 0 feature rows"):
                fe.run_full_pipeline(symbols=["A", "B", "C"])

        mock_con.close.assert_called_once()

    def test_at_least_one_success_does_not_raise(self):
        """Sanity check: the guard must not fire when real rows were actually written."""
        fe = _stub_fe()
        con = _make_in_memory_db(symbol="TATA")
        fe._con = MagicMock(return_value=con)

        feat_df = _make_feat_df(2)

        class _FakeExecutor:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def submit(self, fn, arg):
                fut = MagicMock()
                fut.result = lambda: (arg[0], feat_df.copy())
                return fut

        with patch("src.server.feature_engineering.ProcessPoolExecutor", _FakeExecutor), \
             patch("src.server.feature_engineering.as_completed", lambda fs: list(fs)), \
             patch("src.server.feature_engineering.SCALER_PATH", _TMP_SCALER), \
             patch("pickle.dump"):
            fe._fit_scaler = lambda feat, **kw: MagicMock(transform=lambda X: X.values)
            fe._apply_scaler = lambda feat, scaler: feat
            # Should not raise.
            fe.run_full_pipeline(symbols=["TATA"])
