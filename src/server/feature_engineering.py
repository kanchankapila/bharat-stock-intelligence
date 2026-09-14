#!/usr/bin/env python3
"""
Feature engineering pipeline: computes 84 ML-ready features per (symbol, date)
and writes to feature_store. Enforces strict leakage prevention rules.
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

import sys
import math
import json
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional


def _worker_init() -> None:
    """Redirect worker-process stdio to DEVNULL.

    On Windows, ProcessPoolExecutor workers are spawned as new python.exe processes that
    inherit the *parent's* file descriptors — including the stdio pipe endpoints that Node's
    spawn() gave the top-level Python process. When Node kills the parent via
    taskkill /T /F those handles survive in the workers, preventing the pipe's 'close'
    event from firing in Node and causing the _runningPython slot to leak indefinitely.
    Redirecting the workers' stdio to os.devnull severs that inheritance chain.
    """
    import os
    devnull = open(os.devnull, 'w')  # noqa: WPS515 — intentionally left open for process lifetime
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    try:
        os.dup2(devnull.fileno(), sys.stdout.fileno())
        os.dup2(devnull.fileno(), sys.stderr.fileno())
    except Exception:
        pass


import numpy as np
import pandas as pd
import ta

from db_compat import connect, read_df, use_postgres, ConnWrapper
from as_of import read_as_of_history, logical_write_floor
from insider_features import insider_buy_pct_series

# Quarterly results are usable only once published: SEBI allows 45 days after a quarter and 60
# after Q4, and the deep tables are stamped at period END -- so a value becomes visible 60 days
# later, never on the quarter's own date.
DEEP_QUARTERLY_LAG_DAYS = 60
# A quarterly value older than this (from its availability date) reads as missing, not current.
DEEP_QUARTERLY_STALE_DAYS = 200


def _asof_columns(index: pd.DatetimeIndex, df: pd.DataFrame, date_col: str, cols: list,
                  lag_days: int = 0, tolerance_days: Optional[int] = None) -> pd.DataFrame:
    """For each date in `index`, the latest row of `df` whose date_col + lag_days <= that date."""
    out = pd.DataFrame(np.nan, index=index, columns=cols)
    if df is None or df.empty:
        return out
    right = df[[date_col] + cols].copy()
    right["_avail"] = pd.to_datetime(right[date_col], errors="coerce").astype("datetime64[ns]") \
        + pd.Timedelta(days=lag_days)
    right = right.dropna(subset=["_avail"]).sort_values("_avail")
    for c in cols:
        right[c] = pd.to_numeric(right[c], errors="coerce")
    left = pd.DataFrame({"_d": pd.DatetimeIndex(index).astype("datetime64[ns]"),
                         "_pos": np.arange(len(index))}).sort_values("_d")
    m = pd.merge_asof(left, right[["_avail"] + cols], left_on="_d", right_on="_avail",
                      direction="backward",
                      tolerance=pd.Timedelta(days=tolerance_days) if tolerance_days else None)
    out[cols] = m.sort_values("_pos")[cols].to_numpy()
    return out


def _quarterly_yoy(q: pd.DataFrame, value_col: str) -> pd.DataFrame:
    """Growth vs the same quarter a year earlier (period_end 350-380 days back), abs denominator."""
    q = q[["period_end", value_col]].copy()
    q["period_end"] = pd.to_datetime(q["period_end"]).astype("datetime64[ns]")
    q[value_col] = pd.to_numeric(q[value_col], errors="coerce")
    q = q.dropna().sort_values("period_end")
    prev = q.rename(columns={"period_end": "prev_end", value_col: "prev_val"})
    q["_target"] = q["period_end"] - pd.Timedelta(days=365)
    m = pd.merge_asof(q.sort_values("_target"), prev, left_on="_target", right_on="prev_end",
                      direction="nearest", tolerance=pd.Timedelta(days=15))
    ok = m["prev_val"].notna() & (m["prev_val"] != 0)
    m["growth"] = np.where(ok, (m[value_col] - m["prev_val"]) / m["prev_val"].abs(), np.nan)
    return m[["period_end", "growth"]]
from sqlalchemy.exc import OperationalError, PendingRollbackError, InterfaceError


# INSERT OR REPLACE → portable ON CONFLICT for feature_store (PK: symbol, date, timeframe).
_FEATURE_STORE_CONFLICT = (
    " ON CONFLICT(symbol, date, timeframe) DO UPDATE SET " +
    ", ".join(
        f"{c}=EXCLUDED.{c}" for c in (
            "ret_1d", "ret_5d", "ret_15d", "ret_21d", "ret_63d", "ret_126d", "ret_252d", "ret_12m_ex1m",
            "sma20", "sma50", "sma200", "ema8", "ema21", "dist_sma20_pct", "dist_sma200_pct",
            "above_sma200", "rsi_14", "rsi_28", "macd", "macd_signal", "macd_hist", "adx",
            "di_plus", "di_minus", "stoch_k", "stoch_d", "cci", "williams_r", "atr_14",
            "atr_pct", "bb_upper", "bb_lower", "bb_width", "bb_pct", "hist_vol_21d",
            "hist_vol_63d", "vol_regime", "volume_ratio_20d", "volume_ratio_5d", "obv",
            "obv_slope", "vwap", "vwap_dist_pct", "trend_1d", "trend_1w", "trend_1m",
            "mtf_alignment_score",
            "pcr_oi", "pcr_vol", "iv_rank", "iv_skew", "delivery_pct",
            "insider_buy_pct_90d", "block_deal_net_qty", "block_deal_value_cr",
            "block_deal_net_qty_5d", "block_deal_value_cr_5d",
            "analyst_buy_pct",
            "analyst_target_mean",
            "analyst_target_upside_pct",
            "analyst_n",
            "broker_recos_90d",
            "days_to_next_earnings",
            "days_since_last_earnings",
            "last_eps_surprise_pct",
            "last_beat_score",
            "earnings_in_5d",
            "delivery_z_20d",
            "delivery_pct_chg_5d",
            "delivery_qty_5d",
            "nifty_pcr",
            "call_wall_dist_pct", "put_wall_dist_pct", "near_expiry_gamma", "max_pain",
            "sector_ret_5d", "sector_ret_21d",
            "nifty_pe", "advance_decline_ratio",
            "price_to_book", "rev_growth", "eps_growth",
            "fii_3d_net", "fii_10d_net", "dii_3d_net", "trailing_pe",
            "roe", "debt_to_equity", "op_margins", "piotroski_f", "earnings_yield",
            "nifty_vix", "nifty_ret_5d", "nifty_ret_21d", "us_10y_yield", "dxy",
            "crude_ret_5d", "gold_ret_5d", "sp500_ret_5d", "news_sentiment_score",
            "news_impact_count", "target_ret_1d", "target_ret_5d", "target_ret_15d",
            "target_dir_1d", "target_dir_5d", "target_dir_15d",
        )
    ) + ", computed_at=CURRENT_TIMESTAMP"
)

# FII/DII lag: published next morning
FII_LAG_DAYS = 1



def recover_from_failed_statement(con, symbol: str, exc: Exception) -> bool:
    """Recover a connection after a per-symbol statement failed. Returns True if `con` is usable
    again, False if the caller must discard and reopen it.

    On Postgres a failed statement aborts the entire transaction: without this, every later
    symbol on the same connection dies with "current transaction is aborted" /
    PendingRollbackError, each reporting the abort rather than its own cause. One symbol's real
    error silently becomes a total run failure -- observed live 2026-08-31, where
    dl-feature-refresh logged "[FE] ERROR processing <SYM>" for symbol after symbol, all of them
    the same downstream abort. SQLite tolerates the pattern, which is why it survived the
    Postgres migration (recurring-bugs.md).

    Reports on stderr because pythonRunner only inspects stderr; a stdout-only message here is
    invisible to the one hook that would surface it.

    rollback() itself can raise when the connection is genuinely dead. That is swallowed on
    purpose: the caller's next write will fail loudly and take its own reconnect path, and
    turning a dead socket into a second exception here only buries the original cause.
    """
    print(f"[FE] ERROR processing {symbol}: {exc}", file=sys.stderr)
    try:
        con.rollback()
        return True
    except Exception as rb_err:
        # rollback() failing means the connection is genuinely gone, not merely aborted -- which
        # is what the live 2026-08-31 trace actually was (SQLAlchemy _revalidate_connection ->
        # PendingRollbackError, i.e. it tried to RECONNECT while a transaction was pending).
        # Rolling back cannot fix that; only reopening can, so tell the caller to.
        print(f"[FE] rollback after {symbol} failed ({rb_err}) -- connection is dead, "
              f"reopening before the next symbol", file=sys.stderr)
        return False


def _finite_only(d: dict) -> dict:
    """Map non-finite floats to None so they reach SQL as NULL, never as a sentinel.

    feature_store persists raw values as of 2026-09-10, so a construction-warmup NaN
    (rsi_14's first 13 rows) or an inf from a near-zero denominator now arrives at the DB
    boundary instead of being swallowed by the old `fillna(0)` inside _apply_scaler.
    Writing 0.0 would fabricate a real-looking reading invisible to every NULL/coverage
    check -- that is exactly how roe/trailing_pe/piotroski_f came to read 74-84% "populated"
    while holding literal zeros. Writing NaN is worse still on Postgres, where NaN = NaN is
    TRUE, NaN sorts HIGHEST under ORDER BY, and the IEEE `x != x` test matches nothing
    (.claude/rules/recurring-bugs.md). NULL is the only honest value for "not computable".
    """
    return {
        k: (None if isinstance(v, (float, np.floating)) and not math.isfinite(v) else v)
        for k, v in d.items()
    }


def purge_orphan_feature_rows(con) -> int:
    """Delete feature_store rows with no clean stock_ohlcv bar. Returns the row count removed.

    `run_full_pipeline` upserts on (symbol, date, timeframe) and can only write dates that exist
    as clean bars, so a row for any OTHER date survives every rebuild untouched -- forever
    uncorrectable and silently wrong. This is `recurring-bugs.md`'s standing rule ("a table
    written as today's full recomputation needs a purge of rows the run did not produce, not
    just an upsert"), which had already bitten `unified_recommendations`,
    `intraday_outcome_resolver` and `stock_event_triggers`.

    Measured live 2026-09-10 after the raw rebuild (AF-20260910-18): 2,207 orphans, of which
    **2,130 sat on 2026-08-09 -- a SUNDAY**, a day NSE never traded and for which no bar can
    ever exist. Those were not backfillable missing data; they were rows that should never have
    been written. The rest were computed from bars since quarantined as `is_suspect=1`, which
    measurement.md's panel spec mandates excluding anyway.
    """
    cur = con.cursor()
    cur.execute(
        "DELETE FROM feature_store f "
        "WHERE NOT EXISTS (SELECT 1 FROM stock_ohlcv o "
        "                  WHERE o.symbol = f.symbol AND o.date = f.date "
        "                    AND COALESCE(o.is_suspect, 0) = 0)"
    )
    removed = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    con.commit()
    if removed:
        print(f"[FE] Purged {removed} orphan feature_store rows (no clean OHLCV bar)")
    return removed


_GLOBAL_SERIES_CACHE: dict = {}


def clear_global_series_cache() -> None:
    _GLOBAL_SERIES_CACHE.clear()


def _read_global(sql: str, params=()) -> pd.DataFrame:
    """A market-wide series (identical for every symbol), read once per process per run.

    The merges below re-read the same 10 series for each of ~2,426 symbols: 98ms of the 8
    cheapest alone per symbol (2026-09-11), ~24k identical queries per run. Pool workers are
    spawned per run and run_full_pipeline() clears this, so it never outlives the run's data.
    Callers mutate the frame, so each gets a copy.
    """
    key = (sql, tuple(params))
    df = _GLOBAL_SERIES_CACHE.get(key)
    if df is None:
        df = read_df(sql, params)
        _GLOBAL_SERIES_CACHE[key] = df
    return df.copy()


class FeatureEngineer:
    def _con(self) -> ConnWrapper:
        con = connect()
        if not use_postgres():
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA busy_timeout=5000")
        return con

    # ── Core OHLCV feature computation ──────────────────────────────────────

    def _compute_ohlcv_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Compute price, momentum, volatility, volume features from OHLCV data."""
        close = df["close"]
        high  = df["high"]
        low   = df["low"]
        vol   = df["volume"]

        out = pd.DataFrame(index=df.index)

        # Returns
        for d in [1, 5, 15, 21, 63, 126, 252]:
            out[f"ret_{d}d"] = close.pct_change(d)
        out["ret_12m_ex1m"] = close.pct_change(252) - close.pct_change(21)

        # Trend / moving averages
        out["sma20"]  = close.rolling(20).mean()
        out["sma50"]  = close.rolling(50).mean()
        out["sma200"] = close.rolling(200).mean()
        out["ema8"]   = close.ewm(span=8,  adjust=False).mean()
        out["ema21"]  = close.ewm(span=21, adjust=False).mean()
        out["dist_sma20_pct"]  = (close - out["sma20"])  / out["sma20"]
        out["dist_sma200_pct"] = (close - out["sma200"]) / out["sma200"]
        out["above_sma200"]    = (close > out["sma200"]).astype(int)

        # Momentum
        out["rsi_14"] = ta.momentum.RSIIndicator(close, window=14).rsi()
        out["rsi_28"] = ta.momentum.RSIIndicator(close, window=28).rsi()
        macd_ind = ta.trend.MACD(close)
        out["macd"]        = macd_ind.macd()
        out["macd_signal"] = macd_ind.macd_signal()
        out["macd_hist"]   = macd_ind.macd_diff()
        adx_ind = ta.trend.ADXIndicator(high, low, close, window=14)
        out["adx"]      = adx_ind.adx()
        out["di_plus"]  = adx_ind.adx_pos()
        out["di_minus"] = adx_ind.adx_neg()
        stoch = ta.momentum.StochasticOscillator(high, low, close, window=14, smooth_window=3)
        out["stoch_k"] = stoch.stoch()
        out["stoch_d"] = stoch.stoch_signal()
        out["cci"]       = ta.trend.CCIIndicator(high, low, close, window=20).cci()
        out["williams_r"] = ta.momentum.WilliamsRIndicator(high, low, close, lbp=14).williams_r()

        # Volatility
        atr = ta.volatility.AverageTrueRange(high, low, close, window=14)
        out["atr_14"]  = atr.average_true_range()
        out["atr_pct"] = out["atr_14"] / close
        bb = ta.volatility.BollingerBands(close, window=20, window_dev=2)
        out["bb_upper"] = bb.bollinger_hband()
        out["bb_lower"] = bb.bollinger_lband()
        out["bb_width"] = bb.bollinger_wband()
        out["bb_pct"]   = bb.bollinger_pband()
        log_ret = np.log(close / close.shift(1))
        out["hist_vol_21d"] = log_ret.rolling(21).std() * np.sqrt(252)
        out["hist_vol_63d"] = log_ret.rolling(63).std() * np.sqrt(252)
        # vol_regime: LOW / MED / HIGH / SPIKE
        p33 = out["hist_vol_21d"].quantile(0.33)
        p67 = out["hist_vol_21d"].quantile(0.67)
        p90 = out["hist_vol_21d"].quantile(0.90)
        try:
            out["vol_regime"] = pd.cut(
                out["hist_vol_21d"],
                bins=[-np.inf, p33, p67, p90, np.inf],
                labels=["LOW", "MED", "HIGH", "SPIKE"],
                duplicates="drop",
            ).astype(str).replace("nan", "MED")
        except ValueError:
            # All quantiles equal (zero-variance vol) — assign uniform MED
            out["vol_regime"] = "MED"

        # Volume
        vol_ma5  = vol.rolling(5).mean()
        vol_ma20 = vol.rolling(20).mean()
        out["volume_ratio_5d"]  = vol / vol_ma5
        out["volume_ratio_20d"] = vol / vol_ma20
        out["obv"] = ta.volume.OnBalanceVolumeIndicator(close, vol).on_balance_volume()
        out["obv_slope"] = out["obv"].rolling(10).apply(
            lambda x: np.polyfit(range(len(x)), x, 1)[0] if len(x) == 10 else np.nan
        )
        # VWAP: daily rolling approximation
        tp = (high + low + close) / 3
        out["vwap"] = (tp * vol).cumsum() / vol.cumsum()
        out["vwap_dist_pct"] = (close - out["vwap"]) / out["vwap"]

        # Multi-timeframe trend
        def classify_trend(s: pd.Series) -> str:
            if len(s.dropna()) < 2:
                return "SIDEWAYS"
            slope = np.polyfit(range(len(s)), s.values, 1)[0]
            pct   = slope / s.iloc[0] if s.iloc[0] != 0 else 0
            if pct > 0.001:  return "UP"
            if pct < -0.001: return "DOWN"
            return "SIDEWAYS"

        out["trend_1d"] = close.rolling(5).apply(
            lambda x: {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}[classify_trend(pd.Series(x))],
            raw=False,
        )
        out["trend_1w"] = close.rolling(25).apply(
            lambda x: {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}[classify_trend(pd.Series(x))],
            raw=False,
        )
        out["trend_1m"] = close.rolling(63).apply(
            lambda x: {"UP": 1, "DOWN": -1, "SIDEWAYS": 0}[classify_trend(pd.Series(x))],
            raw=False,
        )
        out["mtf_alignment_score"] = (
            out["trend_1d"] + out["trend_1w"] + out["trend_1m"]
        ) / 3.0

        # Forward targets — shift by 1 to avoid same-day leakage
        # target at date T = return starting from T+1
        out["target_ret_1d"]  = close.pct_change(1).shift(-2)
        out["target_ret_5d"]  = close.pct_change(5).shift(-6)
        out["target_ret_15d"] = close.pct_change(15).shift(-16)
        out["target_dir_1d"]  = (out["target_ret_1d"]  > 0).astype("Int64")
        out["target_dir_5d"]  = (out["target_ret_5d"]  > 0).astype("Int64")
        out["target_dir_15d"] = (out["target_ret_15d"] > 0).astype("Int64")

        return out

    # ── Merge exogenous features ─────────────────────────────────────────────

    def _merge_fii(self, feat: pd.DataFrame) -> pd.DataFrame:
        """FII/DII flows — lagged 1 day (published next morning)."""
        fii = _read_global("SELECT date, fii_net, dii_net FROM fii_dii_flow ORDER BY date")
        fii["date"] = pd.to_datetime(fii["date"])
        fii = fii.set_index("date")
        fii = fii[fii.index.notnull()]
        fii = fii.shift(FII_LAG_DAYS)  # lag 1 day
        feat["fii_3d_net"]  = fii["fii_net"].rolling(3).sum()
        feat["fii_10d_net"] = fii["fii_net"].rolling(10).sum()
        feat["dii_3d_net"]  = fii["dii_net"].rolling(3).sum()
        return feat

    def _merge_fundamentals(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Fundamentals — point-in-time as-of join against fundamentals_history.

        stock_fundamentals is a *current* snapshot only (keyed on last_updated, not an
        as-of date). The old lag check compared last_updated to TODAY and, if old enough,
        broadcast that single current value across the ENTIRE feat window (up to 504 days
        of history) -- stamping today's fundamentals onto months-old dates. fundamentals_history
        accumulates a daily as-of trail (fundamentals_snapshot.py); merge_asof pulls, for each
        date, only the snapshot actually known by then. Dates before history coverage begins
        get NaN, not a leaked current value.
        """
        hist = read_as_of_history(
            "fundamentals_history", symbol,
            ["return_on_equity", "debt_to_equity", "operating_margins",
             "piotroski_f_score"],
        )
        if hist.empty:
            return feat

        date_col = feat.index.name or "index"
        left = feat.reset_index()
        # PG timestamptz and the SQLite text-parsed as_of_date can come back as different
        # datetime64 resolutions (e.g. [s] vs [us]) depending on driver/pandas version --
        # merge_asof requires the join keys to share an exact dtype.
        left[date_col] = pd.to_datetime(left[date_col]).astype("datetime64[ns]")
        left = left.sort_values(date_col)
        merged = pd.merge_asof(
            left, hist, left_on=date_col, right_on="as_of_date", direction="backward",
        ).set_index(date_col).reindex(feat.index)

        feat["roe"]            = merged["return_on_equity"]
        feat["debt_to_equity"] = merged["debt_to_equity"]
        feat["op_margins"]     = merged["operating_margins"]
        feat["piotroski_f"]    = merged["piotroski_f_score"]
        # trailing_pe/earnings_yield/price_to_book/rev_growth/eps_growth moved to
        # _merge_deep_history (AF-20260913-02): fundamentals_history only starts 2026-06-30.
        return feat

    # Max trading days a forward-filled macro/sentiment value may carry before it reads as
    # missing (NaN) again. Without this, a multi-week gap in a fetcher (e.g. a stalled
    # global_macro_fetcher.py run) would silently carry a stale value indefinitely across
    # the whole feature window instead of surfacing as missing data.
    FFILL_LIMIT_DAYS = 5

    def _merge_macro(self, feat: pd.DataFrame) -> pd.DataFrame:
        """India macro + global macro from macro_asset_prices."""
        macro_syms = {
            "US10Y": "us_10y_yield", "DXY": "dxy",
            "CRUDE": "crude_ret_5d", "GOLD": "gold_ret_5d", "SP500": "sp500_ret_5d",
        }
        for sym, col in macro_syms.items():
            df = _read_global(
                "SELECT date, ret_5d FROM macro_asset_prices WHERE symbol=? ORDER BY date",
                (sym,),
            )
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date")
            df = df[df.index.notnull()]
            if not df.empty:
                feat[col] = df["ret_5d"].reindex(feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS)

        # Nifty metrics
        nifty = _read_global("SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' ORDER BY date")
        nifty["date"] = pd.to_datetime(nifty["date"])
        nifty = nifty.set_index("date")
        nifty = nifty[nifty.index.notnull()]
        if not nifty.empty:
            feat["nifty_ret_5d"]  = nifty["close"].pct_change(5).reindex(feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS)
            feat["nifty_ret_21d"] = nifty["close"].pct_change(21).reindex(feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS)

        # India VIX from macro_asset_prices (true implied-vol index; was a weak NSEBANK proxy)
        vix_df = _read_global("SELECT date, close FROM macro_asset_prices WHERE symbol='INDIAVIX' ORDER BY date")
        vix_df["date"] = pd.to_datetime(vix_df["date"])
        vix_df = vix_df.set_index("date")
        vix_df = vix_df[vix_df.index.notnull()]
        if not vix_df.empty:
            feat["nifty_vix"] = vix_df["close"].reindex(feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS)

        return feat

    def _merge_sentiment(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """News sentiment: 3-day avg score + 5-day HIGH-impact article count."""
        # published_at is TIMESTAMPTZ on Postgres / TEXT on SQLite. The `!= ''` empty-string
        # guard is needed (and valid) only on the TEXT/SQLite side — on Postgres comparing a
        # timestamptz to '' raises InvalidDatetimeFormat. DATE() maps to ::date on PG via the
        # translator, which is valid for timestamptz.
        empty_guard = "" if use_postgres() else "AND published_at != ''"
        rows = read_df(
            f"""SELECT DATE(published_at) as date,
                      AVG(CASE WHEN sentiment='BULLISH' THEN 1 WHEN sentiment='BEARISH' THEN -1 ELSE 0 END) as score,
                      SUM(CASE WHEN impact='HIGH' THEN 1 ELSE 0 END) as high_count
               FROM news_sentiment_items
               WHERE symbols_json LIKE ? AND published_at IS NOT NULL {empty_guard}
               GROUP BY DATE(published_at) ORDER BY DATE(published_at)""",
            (f'%"{symbol}"%',),
        )
        rows["date"] = pd.to_datetime(rows["date"], errors="coerce")
        rows = rows.set_index("date")
        rows = rows[rows.index.notnull()]
        if not rows.empty:
            feat["news_sentiment_score"] = rows["score"].rolling(3).mean().reindex(
                feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS
            )
            feat["news_impact_count"] = rows["high_count"].rolling(5).sum().reindex(
                feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS
            )
        return feat

    # Columns pulled from technical_signals (options flow / delivery / smart money / sector
    # momentum). technical_signals populates each field only on dates its upstream fetcher
    # ran, so everything is joined as-is with NO forward-fill: carrying Friday's PCR/IV/
    # delivery into next week would fabricate exactly the freshness signal these columns
    # encode (the same NEVER_FILL doctrine densify_feature_matrix.py applies to the
    # technical_signals side of the same tables).
    FLOW_COLUMNS = (
        # delivery_pct/insider_buy_pct_90d come from _merge_deep_history (AF-20260913-02)
        "pcr_oi", "pcr_vol", "iv_rank", "iv_skew",
        "block_deal_net_qty",
        "call_wall_dist_pct", "put_wall_dist_pct", "near_expiry_gamma",
        "sector_ret_5d", "sector_ret_21d",
    )

    # Per-process memo for _compute_sector_momentum: every symbol in a sector issues the
    # IDENTICAL window query, so cache (sector, start, end) -> DataFrame. Bounded (14 mapped
    # sectors x a handful of distinct date windows per run); each entry is dates x 2 floats.
    _SECTOR_MOM_CACHE: dict = {}

    def _compute_sector_momentum(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Universal fallback producer for sector_ret_5d/21d -- HOLE-FILL ONLY.

        Mirrors technicalSignalsService.getSectorMomentum(): the equal-weight mean of
        (close_t / close_{t-lookback} - 1) * 100 across all nse_stocks members of the
        symbol's sector, i.e. PERCENT units like every stored upstream value (live
        2026-08-24: technical_signals holds -1.98/-0.48-scale values; feature_store min
        -4.34). Implementation notes / deliberate deviations from the TS SQL:
          * LAG(close, N) over the trading-day calendar == the TS subquery's
            `date < d ORDER BY date DESC LIMIT 1 OFFSET N-1` (5th/21st prior bar) without
            the correlated per-row scan.
          * COALESCE(is_suspect,0)=0 excludes bars ohlcv_quality flagged -- the TS service
            predates that table; feeding known-bad closes into a sector mean would poison
            every member symbol's value for that day.
          * NULLIF(denominator, 0) guards divide-by-zero (same shape the TS query risks).
        Applies ONLY where the technical_signals join left NaN (upstream absence -- the
        backfill inserted explicit NULLs, coverage was 47.6% of D rows); never clobbers a
        real value. Symbols with no nse_stocks sector mapping (61/2,424) stay NaN.
        """
        if feat.empty:
            return feat
        sec = read_df(
            "SELECT sector FROM nse_stocks WHERE symbol=? AND sector IS NOT NULL LIMIT 1",
            (symbol,),
        )
        if sec.empty or not sec.iloc[0]["sector"]:
            return feat
        sector = str(sec.iloc[0]["sector"])
        start = feat.index.min().strftime("%Y-%m-%d")
        end   = feat.index.max().strftime("%Y-%m-%d")
        # Fetch from 40 calendar days earlier so LAG(close, 21) sees real history: computing
        # the lag INSIDE a start-bounded window starves the first ~21 window dates of
        # lookback (their whole-sector AVG degenerates to NULL). The warm-up rows are
        # trimmed below; only requested dates are ever emitted.
        widened_start = (pd.Timestamp(start) - pd.Timedelta(days=40)).strftime("%Y-%m-%d")

        cache_key = (sector, widened_start, end)
        mom = self._SECTOR_MOM_CACHE.get(cache_key)
        if mom is None:
            mom = read_df(
                """SELECT date,
                          AVG(100.0 * (close / NULLIF(prev5, 0)  - 1)) AS sector_ret_5d,
                          AVG(100.0 * (close / NULLIF(prev21, 0) - 1)) AS sector_ret_21d
                   FROM (
                       SELECT symbol, date, close,
                              LAG(close, 5)  OVER (PARTITION BY symbol ORDER BY date) AS prev5,
                              LAG(close, 21) OVER (PARTITION BY symbol ORDER BY date) AS prev21
                       FROM stock_ohlcv
                       WHERE symbol IN (SELECT symbol FROM nse_stocks WHERE sector=?)
                         AND COALESCE(is_suspect, 0)=0
                         AND date BETWEEN ? AND ?
                   ) t
                   WHERE t.date >= ?
                   GROUP BY date ORDER BY date""",
                (sector, widened_start, end, start),
            )
            if mom.empty:
                mom = pd.DataFrame(columns=["date", "sector_ret_5d", "sector_ret_21d"])
                mom = mom.set_index("date")
            else:
                mom["date"] = pd.to_datetime(mom["date"])
                mom = mom.set_index("date").sort_index()
                # An all-NULL AVG arrives as Python None -> object dtype, which explodes
                # later .loc assignment into the float64 feature column (pandas 3 refuses
                # the silent upcast). Coerce to real NaN floats at the boundary.
                for c in ("sector_ret_5d", "sector_ret_21d"):
                    mom[c] = pd.to_numeric(mom[c], errors="coerce")
            self._SECTOR_MOM_CACHE[cache_key] = mom

        for col in ("sector_ret_5d", "sector_ret_21d"):
            # to_numeric: an empty/all-NULL cache column is object-dtype; assigning that
            # into feat's float64 column trips pandas 3's silent-upcast TypeError.
            filled = pd.to_numeric(mom[col].reindex(feat.index), errors="coerce")
            if col in feat.columns:
                holes = feat[col].isna()
                feat.loc[holes, col] = filled[holes]
            else:
                feat[col] = filled
        return feat

    def _merge_flow_features(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Options-flow / delivery / smart-money / sector-momentum features.

        Gap #4 root cause: dl_engine has always SELECTed pcr_oi/pcr_vol/iv_rank/
        delivery_pct/max_pain/... from feature_store, but feature_engineering never wrote
        any of them -- every DL training row consumed COALESCE(col, 0) zeros. Source is
        technical_signals (the same per-symbol daily grid the ensemble joins directly);
        it carries every flow column EXCEPT max_pain, whose only per-symbol home is
        so_stock_oi_summary (symbol/date/expiry grain -- the same table fno.router.ts
        reads). Take the NEAREST expiry per day, mirroring that router's
        DISTINCT ON ... ORDER BY expiry ASC. Coverage is sparse by construction (the
        Trendlyne chain fetcher only began populating the table in Jul 2026), so older
        dates stay NULL -- NEVER_FILL, same doctrine as the flow columns above.

        Accepted gaps (2026-08-24 audit): near_expiry_gamma is genuinely sparse upstream
        (RELIANCE last 45 sessions: 36/41 stored values are exact zeros -- the chain
        engine writes it mainly on gamma-flip days). sector_ret_5d/21d had NO live
        producer: the only writer, backfill_technical_features.py, inserted both as
        explicit NULLs, leaving feature_store coverage at 47.6% of D rows (395k/831k).
        Fixed same day by _compute_sector_momentum() below -- a universal fallback that
        derives both columns straight from stock_ohlcv ⋈ nse_stocks for EVERY symbol with
        a mapped sector, applied here as HOLE-FILL ONLY (upstream absence, not poison:
        unlike iv_skew's constant-0 placeholder there is no wrong value to preserve, but
        equally no reason to clobber a real value if technical_signals ever grows one).

        iv_skew: technical_signals carries it as a CONSTANT 0.0 placeholder (live
        2026-08-24: 33/33 stored values exactly 0.0 -- a fabricated neutral, the exact
        zero-poisoning shape this pipeline fights). Replace it outright with a real
        derivation from so_stock_oi_summary: nearest-expiry (iv_put - iv_call) per date,
        the same table and read pattern as the max_pain fallback above (and as
        fno.router.ts). Full replacement, not hole-fill: the upstream placeholder is
        wrong everywhere it exists, so preserving it preserves the poison. Dates without
        chain coverage become NaN -- NEVER_FILL, left to the scaler path's NaN handling
        like every other sparse column.
        """
        ts = read_df(
            f"SELECT date, {', '.join(self.FLOW_COLUMNS)} FROM technical_signals "
            "WHERE symbol=? AND date>=? ORDER BY date",
            (symbol, feat.index.min().strftime("%Y-%m-%d")),
        )
        if not ts.empty:
            ts["date"] = pd.to_datetime(ts["date"])
            ts = ts.set_index("date").reindex(feat.index)
            for col in self.FLOW_COLUMNS:
                feat[col] = ts[col]

        feat = self._compute_sector_momentum(feat, symbol)

        # max_pain hole-fill from so_stock_oi_summary: nearest expiry wins per date.
        # Hole-fill only -- never overwrites a value technical_signals supplied
        # (FLOW_COLUMNS has no max_pain today, but keep the guard in case it ever does).
        mp = read_df(
            """SELECT date, max_pain FROM (
                   SELECT date, max_pain,
                          ROW_NUMBER() OVER (PARTITION BY date
                                             ORDER BY expiry ASC) AS rn
                   FROM so_stock_oi_summary
                   WHERE symbol=? AND max_pain IS NOT NULL AND date >= ?
               ) ranked WHERE rn = 1 ORDER BY date""",
            (symbol, feat.index.min().strftime("%Y-%m-%d")),
        )
        if not mp.empty:
            mp["date"] = pd.to_datetime(mp["date"])
            mp = mp.set_index("date")
            mp = mp[mp.index.notnull()].reindex(feat.index)["max_pain"]
            # Hole-fill only -- never overwrite a value technical_signals supplied
            # (FLOW_COLUMNS has no max_pain today, but keep the guard).
            if "max_pain" in feat:
                feat["max_pain"] = feat["max_pain"].fillna(mp)
            else:
                feat["max_pain"] = mp

        # iv_skew: technical_signals carries it as a CONSTANT 0.0 placeholder (live
        # 2026-08-24: 33/33 stored values exactly 0.0 -- a fabricated neutral, the exact
        # zero-poisoning shape this pipeline fights). Replace it outright with a real
        # derivation from so_stock_oi_summary: nearest-expiry (iv_put - iv_call) per date,
        # the same table and read pattern as the max_pain fallback above (and as
        # fno.router.ts). Full replacement, not hole-fill: the upstream placeholder is
        # wrong everywhere it exists, so preserving it preserves the poison. Dates without
        # chain coverage become NaN -- NEVER_FILL, left to the scaler path's NaN handling
        # like every other sparse column.
        skew = read_df(
            """SELECT date, (iv_put - iv_call) AS iv_skew FROM (
                   SELECT date, iv_put, iv_call,
                          ROW_NUMBER() OVER (PARTITION BY date
                                             ORDER BY expiry ASC) AS rn
                   FROM so_stock_oi_summary
                   WHERE symbol=? AND iv_call IS NOT NULL AND iv_put IS NOT NULL
                     AND date >= ?
               ) ranked WHERE rn = 1 ORDER BY date""",
            (symbol, feat.index.min().strftime("%Y-%m-%d")),
        )
        if not skew.empty:
            skew["date"] = pd.to_datetime(skew["date"])
            skew = skew.set_index("date")
            skew = skew[skew.index.notnull()].reindex(feat.index)["iv_skew"]
            feat["iv_skew"] = skew
        return feat

    def _merge_block_deals(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Block-deal smart-money features from block_deals (per-deal table of record).

        Why this exists (2026-09-13): FLOW_COLUMNS.block_deal_net_qty was joined from
        technical_signals, whose block_deal_* columns are stamped ONLY by
        block_deal_fetcher.backfill_technical_signals() for that script's run date --
        any symbol/day where that UPDATE didn't fire (fetcher skipped, or the symbol
        had no technical_signals row) left feature_store NULL forever. Live
        2026-09-13: feature_store.block_deal_net_qty had 877/2,674,984 non-null rows
        (0.03%) while block_deals held 8,657 raw deals across 2,307 symbol/dates.

        This merge reads block_deals DIRECTLY (the table of record) and aggregates
        per day in SQL. Side derivation: trade_type ('buy'/'sell', the tickertape
        source's 8,590 rows) wins; the NSE-source rows (67) carry session labels
        instead, where block_deal_fetcher._parse_deal's rule applies -- "Session 1"
        is the buy side. A deal with neither marker counts as sell qty (conservative:
        unsigned volume still lands in value_cr_5d).

        Columns:
          * block_deal_net_qty   -- HOLE-FILL ONLY into the technical_signals join
            (never clobbers a value the upstream copy supplied), exact-date as-of,
            no ffill: a deal three days ago is not today's flow (NEVER_FILL).
          * block_deal_value_cr  -- NEW; total traded value (cr) that day.
            ml_ensemble already consumes this name (num('block_deal_value_cr', 0.0)),
            which always fell back to its default because feature_store never had
            the column.
          * block_deal_net_qty_5d / block_deal_value_cr_5d -- trailing 5-session
            sums over the feat index (min_count=1): aggregation over the event
            series handles sparsity without fabricating stale daily values.
        """
        deals = read_df(
            """SELECT date,
                      SUM(CASE WHEN is_buy THEN qty ELSE 0 END)  AS buy_qty,
                      SUM(CASE WHEN is_buy THEN 0 ELSE qty END)  AS sell_qty,
                      SUM(CASE WHEN is_buy THEN qty ELSE -qty END) AS net_qty,
                      SUM(value_cr)                              AS value_cr,
                      COUNT(*)                                   AS deal_count
               FROM (SELECT date, qty, value_cr,
                            CASE WHEN LOWER(COALESCE(trade_type, '')) = 'buy'  THEN TRUE
                                 WHEN LOWER(COALESCE(trade_type, '')) = 'sell' THEN FALSE
                                 ELSE session LIKE 'Session 1'
                            END AS is_buy
                     FROM block_deals
                     WHERE symbol = ? AND date >= ?) t
               GROUP BY date ORDER BY date""",
            (symbol, feat.index.min().strftime("%Y-%m-%d")),
        )
        if deals.empty:
            for col in ("block_deal_value_cr", "block_deal_net_qty_5d", "block_deal_value_cr_5d"):
                feat[col] = np.nan
            return feat

        deals["date"] = pd.to_datetime(deals["date"])
        deals = deals.set_index("date")
        deals = deals[deals.index.notnull()].reindex(feat.index)
        # BIGINT/SUM aggregates come back as Decimal through psycopg2 — feature_store
        # columns are DOUBLE PRECISION and every downstream consumer expects floats.
        deals[["net_qty", "value_cr"]] = deals[["net_qty", "value_cr"]].astype(float)

        net = deals["net_qty"]
        if "block_deal_net_qty" in feat:
            feat["block_deal_net_qty"] = feat["block_deal_net_qty"].fillna(net)
        else:
            feat["block_deal_net_qty"] = net
        feat["block_deal_value_cr"] = deals["value_cr"]
        # Trailing 5 SESSION sums (the feat index is the symbol's own trading-day
        # calendar), min_count=1 so a single deal day surfaces in its window.
        feat["block_deal_net_qty_5d"] = net.rolling(5, min_periods=1).sum()
        feat["block_deal_value_cr_5d"] = deals["value_cr"].rolling(5, min_periods=1).sum()
        return feat

    def _merge_analyst_consensus(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Analyst consensus / target-price features (2026-09-13 step 2).

        Source of record: analyst_estimates_history -- symbol-keyed snapshot history
        (as_of_date, n_analysts, buy/hold/sell, target_high/mean/low, eps_est_next),
        joined AS-OF with a 35-day staleness tolerance: a consensus older than ~5
        weeks reads as missing, not current (NEVER_FILL -- snapshots are
        point-in-time; carrying one forward fabricates a stale rating).

        broker_recos_90d counts trendlyne_analyst_targets broker entries in the
        trailing 90 calendar days (event count over a window -- aggregation, not
        stale carry). All columns NaN where the symbol has no coverage.
        """
        idx = feat.index
        for c in ("analyst_buy_pct", "analyst_target_mean", "analyst_target_upside_pct",
                  "analyst_n", "broker_recos_90d"):
            feat[c] = np.nan

        est = read_df(
            """SELECT as_of_date, n_analysts, buy_count, hold_count, sell_count,
                      target_mean, eps_est_next
               FROM analyst_estimates_history
               WHERE symbol=? ORDER BY as_of_date""",
            (symbol,),
        )
        if not est.empty:
            # buy/hold/sell are ALREADY percentages summing to ~100 (verified live
            # 2026-09-13: RELIANCE 96/0/4 with n=26) -- a count ratio produced
            # nonsense like 369%. Sanity-clamp to [0,100]; anything else is
            # corruption and reads as missing (NEVER_FILL).
            raw = pd.to_numeric(est["buy_count"], errors="coerce")
            est["analyst_buy_pct"] = raw.where((raw >= 0) & (raw <= 100))
            asof = _asof_columns(
                idx, est, "as_of_date",
                ["analyst_buy_pct", "target_mean", "n_analysts", "eps_est_next"],
                tolerance_days=35,
            )
            feat["analyst_buy_pct"] = asof["analyst_buy_pct"].to_numpy()
            feat["analyst_n"] = asof["n_analysts"].to_numpy()
            tgt = asof["target_mean"].to_numpy()
            feat["analyst_target_mean"] = tgt
            close = read_df(
                "SELECT date, close FROM stock_ohlcv "
                "WHERE symbol=? AND COALESCE(is_suspect,0)=0 AND date >= ? ORDER BY date",
                (symbol, idx.min().strftime("%Y-%m-%d")),
            )
            if not close.empty:
                close["date"] = pd.to_datetime(close["date"])
                close = close.drop_duplicates("date").set_index("date")["close"].reindex(idx)
                with np.errstate(divide="ignore", invalid="ignore"):
                    feat["analyst_target_upside_pct"] = (tgt / close.to_numpy() - 1.0) * 100.0

        recos = read_df(
            """SELECT reco_date FROM trendlyne_analyst_targets
               WHERE symbol=? AND reco_date IS NOT NULL ORDER BY reco_date""",
            (symbol,),
        )
        if not recos.empty:
            ev = pd.to_datetime(recos["reco_date"], errors="coerce").dropna()
            ev = ev.sort_values().to_numpy()
            days = pd.DatetimeIndex(idx).astype("datetime64[ns]").to_numpy()
            right = np.searchsorted(ev, days, side="right")
            left90 = np.searchsorted(ev, days - np.timedelta64(90, "D"), side="left")
            feat["broker_recos_90d"] = (right - left90).astype(float)
        return feat

    def _merge_earnings_clock(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Earnings event clock + last-surprise features (2026-09-13 step 2).

        days_to_next_earnings / days_since_last_earnings from stock_earnings_dates
        (scid matches the MC ticker symbols in this dataset). last_eps_surprise_pct
        / last_beat_score read stock_earnings_beats as-of (latest quarter_date <=
        the feature date; stale beyond 400 days reads as missing -- a year-old
        surprise is not information). earnings_in_5d flags the announcement-risk
        window; never forward-filled (NaN = no known upcoming earnings, not 0).
        """
        idx = pd.DatetimeIndex(feat.index)
        days = idx.astype("datetime64[ns]").to_numpy()
        for c in ("days_to_next_earnings", "days_since_last_earnings",
                  "last_eps_surprise_pct", "last_beat_score", "earnings_in_5d"):
            feat[c] = np.nan

        ed = read_df(
            """SELECT result_date FROM stock_earnings_dates
               WHERE scid=? AND result_date IS NOT NULL ORDER BY result_date""",
            (symbol,),
        )
        if not ed.empty:
            ev = pd.to_datetime(ed["result_date"], errors="coerce").dropna()
            ev = ev.dt.normalize().sort_values().to_numpy()
            right = np.searchsorted(ev, days, side="right")
            safe_right = np.minimum(right, len(ev) - 1)
            safe_left = np.maximum(right - 1, 0)
            with np.errstate(invalid="ignore"):
                d2n = (ev[safe_right] - days).astype("timedelta64[D]").astype(float)
                dsl = (days - ev[safe_left]).astype("timedelta64[D]").astype(float)
            feat["days_to_next_earnings"] = np.where(right < len(ev), d2n, np.nan)
            feat["days_since_last_earnings"] = np.where(right > 0, dsl, np.nan)
            in5 = (feat["days_to_next_earnings"] >= 0) & \
                  (feat["days_to_next_earnings"] <= 5)
            feat["earnings_in_5d"] = np.where(in5, 1.0, np.nan)

        beats = read_df(
            """SELECT quarter_date, surprise_pct, beat_score FROM stock_earnings_beats
               WHERE symbol=? AND quarter_date IS NOT NULL ORDER BY quarter_date""",
            (symbol,),
        )
        if not beats.empty:
            bq = pd.to_datetime(beats["quarter_date"], errors="coerce")
            beats = beats.loc[bq.notna()].copy()
            beats["_q"] = bq.loc[bq.notna()].sort_values().to_numpy()
            beats = beats.sort_values("_q").reset_index(drop=True)
            q = np.sort(beats["_q"].to_numpy())
            sp = pd.to_numeric(beats["surprise_pct"], errors="coerce").to_numpy()
            bs = pd.to_numeric(beats["beat_score"], errors="coerce").to_numpy()
            right = np.searchsorted(q, days, side="right")
            have = right > 0
            sel = np.maximum(right - 1, 0)
            stale = (days - q[sel]) > np.timedelta64(400, "D")
            feat["last_eps_surprise_pct"] = np.where(have & ~stale, sp[sel], np.nan)
            feat["last_beat_score"] = np.where(have & ~stale, bs[sel], np.nan)
        return feat

    def _merge_delivery(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Delivery-dynamics features from stock_delivery_data (2026-09-13 step 2).

        delivery_pct itself is already wired (from nse_universe_history,
        _merge_deep_history). stock_delivery_data is the same metric from the NSE
        delivery feed with its own daily sync -- here we derive the dynamics the
        static level misses: a 20-session z-score (unusual delivery = conviction
        repricing), the 5-session point change, and the 5-session delivered-quantity
        sum. Exact-date joins; days absent from the feed stay NaN (NEVER_FILL).
        """
        dv = read_df(
            """SELECT date, delivery_pct, delivery_qty FROM stock_delivery_data
               WHERE symbol=? AND date >= ? ORDER BY date""",
            (symbol, feat.index.min().strftime("%Y-%m-%d")),
        )
        for c in ("delivery_z_20d", "delivery_pct_chg_5d", "delivery_qty_5d"):
            feat[c] = np.nan
        if dv.empty:
            return feat
        dv["date"] = pd.to_datetime(dv["date"])
        dv = dv.drop_duplicates("date").set_index("date")
        dv = dv[dv.index.notnull()]
        base = pd.to_numeric(dv["delivery_pct"], errors="coerce").reindex(feat.index)
        qty = pd.to_numeric(dv["delivery_qty"], errors="coerce").reindex(feat.index)
        mean20 = base.rolling(20, min_periods=10).mean()
        std20 = base.rolling(20, min_periods=10).std()
        feat["delivery_z_20d"] = (base - mean20) / std20.replace(0, np.nan)
        feat["delivery_pct_chg_5d"] = base.diff(5)
        feat["delivery_qty_5d"] = qty.rolling(5, min_periods=1).sum()
        return feat

    def _merge_options_backfill(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Options-backfill: kill the pcr_oi/pcr_vol zero-poison tail (2026-09-13 step 3).

        feature_store.pcr_oi/pcr_vol are 3.8% populated -- the Trendlyne chain
        fetcher only began feeding technical_signals in Jul 2026. so_option_chain
        (StockEdge, 8,155 symbol/days back to 2026-06-30) carries per-strike ce/pe
        OI and volume: aggregate to one daily PCR per symbol (put OI / call OI and
        the volume analogue) and HOLE-FILL only -- never clobber a technical_signals
        value. Sanity band 0.05-20: ratio noise outside it is data corruption, not
        flow. nifty_pcr (index-level market context, NIFTY50 from nt_index_pcr_ts,
        daily last reading, bounded ffill like nifty_pe) gives every symbol the same
        derivatives-regime signal; GIFTNIFTY rows are deliberately excluded -- that
        feed's 'pcr' column carries the index LEVEL (~24,000), not a ratio.
        """
        idx = feat.index
        feat["nifty_pcr"] = np.nan
        # _merge_flow_features normally creates pcr_oi/pcr_vol; guarantee them so
        # hole-fill never depends on call order.
        if "pcr_oi" not in feat:
            feat["pcr_oi"] = np.nan
        if "pcr_vol" not in feat:
            feat["pcr_vol"] = np.nan

        pcr = read_df(
            """SELECT date,
                      SUM(pe_oi) / NULLIF(SUM(ce_oi), 0) AS pcr_oi,
                      SUM(pe_volume) / NULLIF(SUM(ce_volume), 0) AS pcr_vol
               FROM so_option_chain
               WHERE symbol=? AND ce_oi > 0
               GROUP BY date
               HAVING SUM(pe_oi) > 0
               ORDER BY date""",
            (symbol,),
        )
        if not pcr.empty:
            pcr["date"] = pd.to_datetime(pcr["date"])
            pcr = pcr.drop_duplicates("date").set_index("date").reindex(idx)
            sane = (pcr["pcr_oi"] >= 0.05) & (pcr["pcr_oi"] <= 20)
            pcr.loc[~sane, ["pcr_oi", "pcr_vol"]] = np.nan
            feat["pcr_oi"] = feat["pcr_oi"].fillna(pcr["pcr_oi"])
            feat["pcr_vol"] = feat["pcr_vol"].fillna(pcr["pcr_vol"])

        npc = read_df(
            """SELECT ts::date AS d, pcr FROM nt_index_pcr_ts
               WHERE index_name='NIFTY50' AND pcr BETWEEN 0.05 AND 20
               ORDER BY ts""",
        )
        if not npc.empty:
            npc = npc.drop_duplicates("d", keep="last")
            npc["d"] = pd.to_datetime(npc["d"])
            npc = npc.set_index("d")["pcr"]
            feat["nifty_pcr"] = npc.reindex(idx, method="ffill", limit=5)
        return feat

    def _merge_deep_history(self, feat: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Valuation/growth/delivery/insider inputs from tables with years of history.

        Their previous sources (fundamentals_history, from 2026-06-30; technical_signals' live
        flow columns) cover only recent months, so a symbol's DL training history held 0 for
        these inputs and real values appeared only at the end (AF-20260913-02). ONE source per
        input for EVERY date -- a symbol the deep table lacks reads NaN throughout rather than
        switching definition when a shallow source starts.

        Sources were chosen by agreement with the values they replace, measured 2026-09-13:
          trailing_pe/earnings_yield  close / trendlyne_eps_history.eps_ttm (consolidated TTM;
                                      Spearman 0.967 vs 100/ey). NOT trendlyne_pe_history.pe_ttm:
                                      it is standalone-based (ADANIPORTS 153 vs 29 consolidated).
          price_to_book               trendlyne_pb_history (0.869, median ratio 0.99)
          eps_growth / rev_growth     dalalos quarterly, same quarter last year (0.917 / 0.899)
          delivery_pct                nse_universe_history bhavcopy (0.992)
          insider_buy_pct_90d         insider_trades, open-market only, 7-day disclosure lag
        """
        idx = feat.index
        start = idx.min()
        s = lambda days: (start - pd.Timedelta(days=days)).strftime("%Y-%m-%d")

        closes = read_df(
            "SELECT date, close FROM stock_ohlcv WHERE symbol=? AND date>=? "
            "AND COALESCE(is_suspect,0)=0 ORDER BY date", (symbol, s(0)))
        close = _asof_columns(idx, closes, "date", ["close"], tolerance_days=1)["close"]

        eps = read_df("SELECT date, eps_ttm FROM trendlyne_eps_history WHERE symbol=? AND date>=? "
                      "ORDER BY date", (symbol, s(500)))
        eps_ttm = _asof_columns(idx, eps, "date", ["eps_ttm"], lag_days=DEEP_QUARTERLY_LAG_DAYS,
                                tolerance_days=DEEP_QUARTERLY_STALE_DAYS)["eps_ttm"]
        nonzero = eps_ttm.notna() & (eps_ttm != 0) & close.notna() & (close != 0)
        feat["trailing_pe"] = np.where(nonzero, close / eps_ttm.where(nonzero, 1.0), np.nan)
        feat["earnings_yield"] = np.where(nonzero, eps_ttm / close.where(nonzero, 1.0), np.nan)

        dal = read_df(
            "SELECT * FROM dalalos_financial_trends_history WHERE symbol=? "
            "AND period_type='quarterly' AND period_end>=? ORDER BY period_end", (symbol, s(900)))
        if not dal.empty and "statement_type" in dal:
            dal = (dal.assign(_c=(dal["statement_type"] != "consolidate").astype(int))
                      .sort_values(["period_end", "_c"]).drop_duplicates("period_end"))
        if dal.empty:
            feat["rev_growth"] = np.nan
            feat["eps_growth"] = np.nan
        else:
            feat["rev_growth"] = _asof_columns(
                idx, dal, "period_end", ["yoy_revenue_growth"], lag_days=DEEP_QUARTERLY_LAG_DAYS,
                tolerance_days=DEEP_QUARTERLY_STALE_DAYS)["yoy_revenue_growth"].to_numpy()
            feat["eps_growth"] = _asof_columns(
                idx, _quarterly_yoy(dal, "eps"), "period_end", ["growth"],
                lag_days=DEEP_QUARTERLY_LAG_DAYS,
                tolerance_days=DEEP_QUARTERLY_STALE_DAYS)["growth"].to_numpy()

        pb = read_df("SELECT date, pb_ratio FROM trendlyne_pb_history WHERE symbol=? AND date>=? "
                     "ORDER BY date", (symbol, s(10)))
        feat["price_to_book"] = _asof_columns(idx, pb, "date", ["pb_ratio"], tolerance_days=5)["pb_ratio"].to_numpy()

        dv = read_df("SELECT date, deliv_pct FROM nse_universe_history WHERE symbol=? AND series='EQ' "
                     "AND date>=? ORDER BY date", (symbol, s(0)))
        if dv.empty:
            feat["delivery_pct"] = np.nan
        else:
            dv["date"] = pd.to_datetime(dv["date"]).astype("datetime64[ns]")
            dv = dv.drop_duplicates("date").set_index("date")["deliv_pct"]
            feat["delivery_pct"] = pd.to_numeric(dv, errors="coerce").reindex(
                pd.DatetimeIndex(idx).astype("datetime64[ns]")).to_numpy()

        trades = read_df('SELECT "acquirerName", "typeOfTransaction", quantity, date_iso '
                         "FROM insider_trades WHERE symbol=? AND date_iso>=?", (symbol, s(120)))
        feat["insider_buy_pct_90d"] = insider_buy_pct_series(trades, idx).to_numpy()
        return feat

    def _merge_market_context(self, feat: pd.DataFrame) -> pd.DataFrame:
        """Market-level regime context: NIFTY50 P/E (index_valuation) and the
        advance/decline ratio (market_breadth).

        Unlike the per-symbol flow fields these are published every trading day and remain
        meaningful across a weekend/holiday gap, so they use the same bounded reindex-ffill
        as the macro merges (FFILL_LIMIT_DAYS caps how stale a carried value may get).
        """
        pe = _read_global(
            "SELECT date, pe FROM index_valuation WHERE index_name='NIFTY50' ORDER BY date"
        )
        if not pe.empty:
            pe["date"] = pd.to_datetime(pe["date"])
            pe = pe.set_index("date")
            pe = pe[pe.index.notnull()]
            feat["nifty_pe"] = pe["pe"].reindex(
                feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS
            )

        breadth = _read_global(
            "SELECT date, adv_decline_ratio FROM market_breadth ORDER BY date"
        )
        if not breadth.empty:
            breadth["date"] = pd.to_datetime(breadth["date"])
            breadth = breadth.set_index("date")
            breadth = breadth[breadth.index.notnull()]
            feat["advance_decline_ratio"] = breadth["adv_decline_ratio"].reindex(
                feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS
            )
        return feat

    # ── Per-symbol pipeline ──────────────────────────────────────────────────

    def process_symbol(self, symbol: str, lookback_days: int = 504,
                       only_date: str = None, *, con: ConnWrapper = None) -> int:
        """Compute + persist features for one symbol. Returns row count written.

        only_date: if set, only write the row matching this date (fast daily mode).
        con: shared connection from caller. If provided, the caller owns the transaction
             and this method will NOT commit. If None, opens, commits, and closes its own.
        """
        owns_con = con is None
        if owns_con:
            con = self._con()
        cutoff = (datetime.today() - timedelta(days=lookback_days)).date()

        try:
            # Reads through `con` (like the write path below) instead of the global-engine
            # read_df() helper -- was ignoring the caller-supplied `con` entirely, which broke
            # the "con: shared connection from caller" contract this method's own docstring
            # promises, and made process_symbol untestable against an isolated connection
            # (test_feature_engineering_batch.py's `patch("pandas.read_sql", ...)` never got a
            # chance to run: the global engine's own connection attempt failed first whenever
            # no live DB was reachable). Functionally identical in the owns_con=True default
            # path, since self._con() opens the same DB read_df()'s global engine would.
            ohlcv_rows = con.execute(
                "SELECT date, open, high, low, close, volume FROM stock_ohlcv "
                "WHERE symbol=? AND date>=? AND COALESCE(is_suspect,0)=0 ORDER BY date",
                (symbol, cutoff),
            ).fetchall()
            ohlcv = pd.DataFrame(ohlcv_rows, columns=["date", "open", "high", "low", "close", "volume"])
            if len(ohlcv) < 60:
                return 0
            ohlcv["date"] = pd.to_datetime(ohlcv["date"])
            ohlcv = ohlcv.set_index("date")

            feat = self._compute_ohlcv_features(ohlcv)
            feat = self._merge_fii(feat)
            feat = self._merge_fundamentals(feat, symbol)
            feat = self._merge_macro(feat)
            feat = self._merge_sentiment(feat, symbol)
            # Gap #4: options-flow/smart-money/sector + market context -- never merged
            # before, so dl_engine trained on zeros for every one of these columns.
            feat = self._merge_flow_features(feat, symbol)
            feat = self._merge_block_deals(feat, symbol)
            feat = self._merge_analyst_consensus(feat, symbol)
            feat = self._merge_earnings_clock(feat, symbol)
            feat = self._merge_delivery(feat, symbol)
            feat = self._merge_options_backfill(feat, symbol)
            feat = self._merge_deep_history(feat, symbol)
            feat = self._merge_market_context(feat)

            # feature_store persists RAW values -- no scaling here. Until 2026-09-10 a
            # RobustScaler was fit PER SYMBOL and applied to every numeric column, targets
            # included, so the stored label was (raw - symbol median)/symbol IQR rather than
            # a return (230,572 live rows held target_ret_5d < -1, impossible for a close
            # ratio) and rsi_14 -- 0-100 by construction -- spanned +/-6.2 million. Worse for
            # the cross-sectional readers (ml_ensemble's wide queries, factor_backtest): a
            # per-symbol affine transform reorders the cross-section, so they were ranking
            # incommensurable units. Normalization is now the consumer's job; dl_engine, the
            # one reader that legitimately wants per-symbol scaling for its LSTM, fits its
            # own over FEATURES ONLY (see dl_engine._scale_features_per_symbol).

            # Collect all rows then write in one executemany call
            SQL = """INSERT INTO feature_store
                       (symbol, date, timeframe,
                        ret_1d, ret_5d, ret_15d, ret_21d, ret_63d, ret_126d, ret_252d, ret_12m_ex1m,
                        sma20, sma50, sma200, ema8, ema21, dist_sma20_pct, dist_sma200_pct, above_sma200,
                        rsi_14, rsi_28, macd, macd_signal, macd_hist, adx, di_plus, di_minus,
                        stoch_k, stoch_d, cci, williams_r,
                        atr_14, atr_pct, bb_upper, bb_lower, bb_width, bb_pct,
                        hist_vol_21d, hist_vol_63d, vol_regime,
                        volume_ratio_20d, volume_ratio_5d, obv, obv_slope, vwap, vwap_dist_pct,
                        trend_1d, trend_1w, trend_1m, mtf_alignment_score,
                        pcr_oi, pcr_vol, iv_rank, iv_skew, delivery_pct,
                        insider_buy_pct_90d, block_deal_net_qty, block_deal_value_cr,
                        block_deal_net_qty_5d, block_deal_value_cr_5d,
                        analyst_buy_pct,
                        analyst_target_mean,
                        analyst_target_upside_pct,
                        analyst_n,
                        broker_recos_90d,
                        days_to_next_earnings,
                        days_since_last_earnings,
                        last_eps_surprise_pct,
                        last_beat_score,
                        earnings_in_5d,
                        delivery_z_20d,
                        delivery_pct_chg_5d,
                        delivery_qty_5d,
                        nifty_pcr,
                        call_wall_dist_pct, put_wall_dist_pct, near_expiry_gamma, max_pain,
                        sector_ret_5d, sector_ret_21d,
                        nifty_pe, advance_decline_ratio,
                        price_to_book, rev_growth, eps_growth,
                        fii_3d_net, fii_10d_net, dii_3d_net,
                        trailing_pe, roe, debt_to_equity, op_margins, piotroski_f, earnings_yield,
                        nifty_vix, nifty_ret_5d, nifty_ret_21d,
                        us_10y_yield, dxy, crude_ret_5d, gold_ret_5d, sp500_ret_5d,
                        news_sentiment_score, news_impact_count,
                        target_ret_1d, target_ret_5d, target_ret_15d,
                        target_dir_1d, target_dir_5d, target_dir_15d,
                        computed_at)
                       VALUES (:sym, :dt, 'D',
                        :ret_1d,:ret_5d,:ret_15d,:ret_21d,:ret_63d,:ret_126d,:ret_252d,:ret_12m_ex1m,
                        :sma20,:sma50,:sma200,:ema8,:ema21,:dist_sma20_pct,:dist_sma200_pct,:above_sma200,
                        :rsi_14,:rsi_28,:macd,:macd_signal,:macd_hist,:adx,:di_plus,:di_minus,
                        :stoch_k,:stoch_d,:cci,:williams_r,
                        :atr_14,:atr_pct,:bb_upper,:bb_lower,:bb_width,:bb_pct,
                        :hist_vol_21d,:hist_vol_63d,:vol_regime,
                        :volume_ratio_20d,:volume_ratio_5d,:obv,:obv_slope,:vwap,:vwap_dist_pct,
                        :trend_1d,:trend_1w,:trend_1m,:mtf_alignment_score,
                        :pcr_oi,:pcr_vol,:iv_rank,:iv_skew,:delivery_pct,
                        :insider_buy_pct_90d,:block_deal_net_qty,:block_deal_value_cr,
                        :block_deal_net_qty_5d,:block_deal_value_cr_5d,
                        :analyst_buy_pct,
                        :analyst_target_mean,
                        :analyst_target_upside_pct,
                        :analyst_n,
                        :broker_recos_90d,
                        :days_to_next_earnings,
                        :days_since_last_earnings,
                        :last_eps_surprise_pct,
                        :last_beat_score,
                        :earnings_in_5d,
                        :delivery_z_20d,
                        :delivery_pct_chg_5d,
                        :delivery_qty_5d,
                        :nifty_pcr,
                        :call_wall_dist_pct,:put_wall_dist_pct,:near_expiry_gamma,:max_pain,
                        :sector_ret_5d,:sector_ret_21d,
                        :nifty_pe,:advance_decline_ratio,
                        :price_to_book,:rev_growth,:eps_growth,
                        :fii_3d_net,:fii_10d_net,:dii_3d_net,
                        :trailing_pe,:roe,:debt_to_equity,:op_margins,:piotroski_f,:earnings_yield,
                        :nifty_vix,:nifty_ret_5d,:nifty_ret_21d,
                        :us_10y_yield,:dxy,:crude_ret_5d,:gold_ret_5d,:sp500_ret_5d,
                        :news_sentiment_score,:news_impact_count,
                        :target_ret_1d,:target_ret_5d,:target_ret_15d,
                        :target_dir_1d,:target_dir_5d,:target_dir_15d,
                        CURRENT_TIMESTAMP)""" + _FEATURE_STORE_CONFLICT
            rows_to_insert = []
            for date, row in feat.iterrows():
                if only_date and date.strftime("%Y-%m-%d") < only_date:
                    continue
                d = _finite_only(row.to_dict())
                rows_to_insert.append({
                    "sym": symbol, "dt": date.strftime("%Y-%m-%d"),
                    "ret_1d": d.get("ret_1d"), "ret_5d": d.get("ret_5d"),
                    "ret_15d": d.get("ret_15d"), "ret_21d": d.get("ret_21d"),
                    "ret_63d": d.get("ret_63d"), "ret_126d": d.get("ret_126d"),
                    "ret_252d": d.get("ret_252d"), "ret_12m_ex1m": d.get("ret_12m_ex1m"),
                    "sma20": d.get("sma20"), "sma50": d.get("sma50"), "sma200": d.get("sma200"),
                    "ema8": d.get("ema8"), "ema21": d.get("ema21"),
                    "dist_sma20_pct": d.get("dist_sma20_pct"), "dist_sma200_pct": d.get("dist_sma200_pct"),
                    "above_sma200": d.get("above_sma200"),
                    "rsi_14": d.get("rsi_14"), "rsi_28": d.get("rsi_28"),
                    "macd": d.get("macd"), "macd_signal": d.get("macd_signal"), "macd_hist": d.get("macd_hist"),
                    "adx": d.get("adx"), "di_plus": d.get("di_plus"), "di_minus": d.get("di_minus"),
                    "stoch_k": d.get("stoch_k"), "stoch_d": d.get("stoch_d"),
                    "cci": d.get("cci"), "williams_r": d.get("williams_r"),
                    "atr_14": d.get("atr_14"), "atr_pct": d.get("atr_pct"),
                    "bb_upper": d.get("bb_upper"), "bb_lower": d.get("bb_lower"),
                    "bb_width": d.get("bb_width"), "bb_pct": d.get("bb_pct"),
                    "hist_vol_21d": d.get("hist_vol_21d"), "hist_vol_63d": d.get("hist_vol_63d"),
                    "vol_regime": d.get("vol_regime"),
                    "volume_ratio_20d": d.get("volume_ratio_20d"), "volume_ratio_5d": d.get("volume_ratio_5d"),
                    "obv": d.get("obv"), "obv_slope": d.get("obv_slope"),
                    "vwap": d.get("vwap"), "vwap_dist_pct": d.get("vwap_dist_pct"),
                    "trend_1d": d.get("trend_1d"), "trend_1w": d.get("trend_1w"), "trend_1m": d.get("trend_1m"),
                    "mtf_alignment_score": d.get("mtf_alignment_score"),
                    "fii_3d_net": d.get("fii_3d_net"), "fii_10d_net": d.get("fii_10d_net"),
                    "dii_3d_net": d.get("dii_3d_net"),
                    "trailing_pe": d.get("trailing_pe"), "roe": d.get("roe"),
                    "debt_to_equity": d.get("debt_to_equity"), "op_margins": d.get("op_margins"),
                    "piotroski_f": d.get("piotroski_f"), "earnings_yield": d.get("earnings_yield"),
                    "nifty_vix": d.get("nifty_vix"), "nifty_ret_5d": d.get("nifty_ret_5d"),
                    "nifty_ret_21d": d.get("nifty_ret_21d"),
                    "us_10y_yield": d.get("us_10y_yield"), "dxy": d.get("dxy"),
                    "crude_ret_5d": d.get("crude_ret_5d"), "gold_ret_5d": d.get("gold_ret_5d"),
                    "sp500_ret_5d": d.get("sp500_ret_5d"),
                    "news_sentiment_score": d.get("news_sentiment_score"),
                    "news_impact_count": d.get("news_impact_count"),
                    "target_ret_1d": d.get("target_ret_1d"), "target_ret_5d": d.get("target_ret_5d"),
                    "target_ret_15d": d.get("target_ret_15d"),
                    "target_dir_1d": d.get("target_dir_1d"), "target_dir_5d": d.get("target_dir_5d"),
                    "target_dir_15d": d.get("target_dir_15d"),
                    "pcr_oi": d.get("pcr_oi"), "pcr_vol": d.get("pcr_vol"),
                    "iv_rank": d.get("iv_rank"), "iv_skew": d.get("iv_skew"),
                    "delivery_pct": d.get("delivery_pct"),
                    "insider_buy_pct_90d": d.get("insider_buy_pct_90d"),
                    "block_deal_net_qty": d.get("block_deal_net_qty"),
                    "block_deal_value_cr": d.get("block_deal_value_cr"),
                    "block_deal_net_qty_5d": d.get("block_deal_net_qty_5d"),
                    "block_deal_value_cr_5d": d.get("block_deal_value_cr_5d"),
                    "analyst_buy_pct": d.get("analyst_buy_pct"),
                    "analyst_target_mean": d.get("analyst_target_mean"),
                    "analyst_target_upside_pct": d.get("analyst_target_upside_pct"),
                    "analyst_n": d.get("analyst_n"),
                    "broker_recos_90d": d.get("broker_recos_90d"),
                    "days_to_next_earnings": d.get("days_to_next_earnings"),
                    "days_since_last_earnings": d.get("days_since_last_earnings"),
                    "last_eps_surprise_pct": d.get("last_eps_surprise_pct"),
                    "last_beat_score": d.get("last_beat_score"),
                    "earnings_in_5d": d.get("earnings_in_5d"),
                    "delivery_z_20d": d.get("delivery_z_20d"),
                    "delivery_pct_chg_5d": d.get("delivery_pct_chg_5d"),
                    "delivery_qty_5d": d.get("delivery_qty_5d"),
                    "nifty_pcr": d.get("nifty_pcr"),
                    "call_wall_dist_pct": d.get("call_wall_dist_pct"),
                    "put_wall_dist_pct": d.get("put_wall_dist_pct"),
                    "near_expiry_gamma": d.get("near_expiry_gamma"),
                    "max_pain": d.get("max_pain"),
                    "sector_ret_5d": d.get("sector_ret_5d"),
                    "sector_ret_21d": d.get("sector_ret_21d"),
                    "nifty_pe": d.get("nifty_pe"),
                    "advance_decline_ratio": d.get("advance_decline_ratio"),
                    "price_to_book": d.get("price_to_book"),
                    "rev_growth": d.get("rev_growth"), "eps_growth": d.get("eps_growth"),
                })

            if rows_to_insert:
                con.executemany(SQL, rows_to_insert)
            if owns_con:
                con.commit()
            return len(rows_to_insert)
        finally:
            if owns_con:
                con.close()

    def _write_symbol_features(self, symbol: str, feat: pd.DataFrame,
                               only_date: str | None, con: ConnWrapper) -> int:
        """Write scaled feature rows for one symbol. Returns row count written."""
        SQL = """INSERT INTO feature_store
                   (symbol, date, timeframe,
                    ret_1d, ret_5d, ret_15d, ret_21d, ret_63d, ret_126d, ret_252d, ret_12m_ex1m,
                    sma20, sma50, sma200, ema8, ema21, dist_sma20_pct, dist_sma200_pct, above_sma200,
                    rsi_14, rsi_28, macd, macd_signal, macd_hist, adx, di_plus, di_minus,
                    stoch_k, stoch_d, cci, williams_r,
                    atr_14, atr_pct, bb_upper, bb_lower, bb_width, bb_pct,
                    hist_vol_21d, hist_vol_63d, vol_regime,
                    volume_ratio_20d, volume_ratio_5d, obv, obv_slope, vwap, vwap_dist_pct,
                    trend_1d, trend_1w, trend_1m, mtf_alignment_score,
                    pcr_oi, pcr_vol, iv_rank, iv_skew, delivery_pct,
                    insider_buy_pct_90d, block_deal_net_qty, block_deal_value_cr,
                    block_deal_net_qty_5d, block_deal_value_cr_5d,
                    analyst_buy_pct,
                    analyst_target_mean,
                    analyst_target_upside_pct,
                    analyst_n,
                    broker_recos_90d,
                    days_to_next_earnings,
                    days_since_last_earnings,
                    last_eps_surprise_pct,
                    last_beat_score,
                    earnings_in_5d,
                    delivery_z_20d,
                    delivery_pct_chg_5d,
                    delivery_qty_5d,
                    nifty_pcr,
                    call_wall_dist_pct, put_wall_dist_pct, near_expiry_gamma, max_pain,
                    sector_ret_5d, sector_ret_21d,
                    nifty_pe, advance_decline_ratio,
                    price_to_book, rev_growth, eps_growth,
                    fii_3d_net, fii_10d_net, dii_3d_net,
                    trailing_pe, roe, debt_to_equity, op_margins, piotroski_f, earnings_yield,
                    nifty_vix, nifty_ret_5d, nifty_ret_21d,
                    us_10y_yield, dxy, crude_ret_5d, gold_ret_5d, sp500_ret_5d,
                    news_sentiment_score, news_impact_count,
                    target_ret_1d, target_ret_5d, target_ret_15d,
                    target_dir_1d, target_dir_5d, target_dir_15d,
                    computed_at)
                   VALUES (:sym, :dt, 'D',
                    :ret_1d,:ret_5d,:ret_15d,:ret_21d,:ret_63d,:ret_126d,:ret_252d,:ret_12m_ex1m,
                    :sma20,:sma50,:sma200,:ema8,:ema21,:dist_sma20_pct,:dist_sma200_pct,:above_sma200,
                    :rsi_14,:rsi_28,:macd,:macd_signal,:macd_hist,:adx,:di_plus,:di_minus,
                    :stoch_k,:stoch_d,:cci,:williams_r,
                    :atr_14,:atr_pct,:bb_upper,:bb_lower,:bb_width,:bb_pct,
                    :hist_vol_21d,:hist_vol_63d,:vol_regime,
                    :volume_ratio_20d,:volume_ratio_5d,:obv,:obv_slope,:vwap,:vwap_dist_pct,
                    :trend_1d,:trend_1w,:trend_1m,:mtf_alignment_score,
                    :pcr_oi,:pcr_vol,:iv_rank,:iv_skew,:delivery_pct,
                    :insider_buy_pct_90d,:block_deal_net_qty,:block_deal_value_cr,
                    :block_deal_net_qty_5d,:block_deal_value_cr_5d,
                    :analyst_buy_pct,
                    :analyst_target_mean,
                    :analyst_target_upside_pct,
                    :analyst_n,
                    :broker_recos_90d,
                    :days_to_next_earnings,
                    :days_since_last_earnings,
                    :last_eps_surprise_pct,
                    :last_beat_score,
                    :earnings_in_5d,
                    :delivery_z_20d,
                    :delivery_pct_chg_5d,
                    :delivery_qty_5d,
                    :nifty_pcr,
                    :call_wall_dist_pct,:put_wall_dist_pct,:near_expiry_gamma,:max_pain,
                    :sector_ret_5d,:sector_ret_21d,
                    :nifty_pe,:advance_decline_ratio,
                    :price_to_book,:rev_growth,:eps_growth,
                    :fii_3d_net,:fii_10d_net,:dii_3d_net,
                    :trailing_pe,:roe,:debt_to_equity,:op_margins,:piotroski_f,:earnings_yield,
                    :nifty_vix,:nifty_ret_5d,:nifty_ret_21d,
                    :us_10y_yield,:dxy,:crude_ret_5d,:gold_ret_5d,:sp500_ret_5d,
                    :news_sentiment_score,:news_impact_count,
                    :target_ret_1d,:target_ret_5d,:target_ret_15d,
                    :target_dir_1d,:target_dir_5d,:target_dir_15d,
                    CURRENT_TIMESTAMP)""" + _FEATURE_STORE_CONFLICT
        rows_to_insert = []
        for date, row in feat.iterrows():
            if only_date and date.strftime("%Y-%m-%d") < only_date:
                continue
            d = _finite_only(row.to_dict())
            rows_to_insert.append({
                "sym": symbol, "dt": date.strftime("%Y-%m-%d"),
                "ret_1d": d.get("ret_1d"), "ret_5d": d.get("ret_5d"),
                "ret_15d": d.get("ret_15d"), "ret_21d": d.get("ret_21d"),
                "ret_63d": d.get("ret_63d"), "ret_126d": d.get("ret_126d"),
                "ret_252d": d.get("ret_252d"), "ret_12m_ex1m": d.get("ret_12m_ex1m"),
                "sma20": d.get("sma20"), "sma50": d.get("sma50"), "sma200": d.get("sma200"),
                "ema8": d.get("ema8"), "ema21": d.get("ema21"),
                "dist_sma20_pct": d.get("dist_sma20_pct"), "dist_sma200_pct": d.get("dist_sma200_pct"),
                "above_sma200": d.get("above_sma200"),
                "rsi_14": d.get("rsi_14"), "rsi_28": d.get("rsi_28"),
                "macd": d.get("macd"), "macd_signal": d.get("macd_signal"), "macd_hist": d.get("macd_hist"),
                "adx": d.get("adx"), "di_plus": d.get("di_plus"), "di_minus": d.get("di_minus"),
                "stoch_k": d.get("stoch_k"), "stoch_d": d.get("stoch_d"),
                "cci": d.get("cci"), "williams_r": d.get("williams_r"),
                "atr_14": d.get("atr_14"), "atr_pct": d.get("atr_pct"),
                "bb_upper": d.get("bb_upper"), "bb_lower": d.get("bb_lower"),
                "bb_width": d.get("bb_width"), "bb_pct": d.get("bb_pct"),
                "hist_vol_21d": d.get("hist_vol_21d"), "hist_vol_63d": d.get("hist_vol_63d"),
                "vol_regime": d.get("vol_regime"),
                "volume_ratio_20d": d.get("volume_ratio_20d"), "volume_ratio_5d": d.get("volume_ratio_5d"),
                "obv": d.get("obv"), "obv_slope": d.get("obv_slope"),
                "vwap": d.get("vwap"), "vwap_dist_pct": d.get("vwap_dist_pct"),
                "trend_1d": d.get("trend_1d"), "trend_1w": d.get("trend_1w"), "trend_1m": d.get("trend_1m"),
                "mtf_alignment_score": d.get("mtf_alignment_score"),
                "fii_3d_net": d.get("fii_3d_net"), "fii_10d_net": d.get("fii_10d_net"),
                "dii_3d_net": d.get("dii_3d_net"),
                "trailing_pe": d.get("trailing_pe"), "roe": d.get("roe"),
                "debt_to_equity": d.get("debt_to_equity"), "op_margins": d.get("op_margins"),
                "piotroski_f": d.get("piotroski_f"), "earnings_yield": d.get("earnings_yield"),
                "nifty_vix": d.get("nifty_vix"), "nifty_ret_5d": d.get("nifty_ret_5d"),
                "nifty_ret_21d": d.get("nifty_ret_21d"),
                "us_10y_yield": d.get("us_10y_yield"), "dxy": d.get("dxy"),
                "crude_ret_5d": d.get("crude_ret_5d"), "gold_ret_5d": d.get("gold_ret_5d"),
                "sp500_ret_5d": d.get("sp500_ret_5d"),
                "news_sentiment_score": d.get("news_sentiment_score"),
                "news_impact_count": d.get("news_impact_count"),
                "target_ret_1d": d.get("target_ret_1d"), "target_ret_5d": d.get("target_ret_5d"),
                "target_ret_15d": d.get("target_ret_15d"),
                "target_dir_1d": d.get("target_dir_1d"), "target_dir_5d": d.get("target_dir_5d"),
                "target_dir_15d": d.get("target_dir_15d"),
                "pcr_oi": d.get("pcr_oi"), "pcr_vol": d.get("pcr_vol"),
                "iv_rank": d.get("iv_rank"), "iv_skew": d.get("iv_skew"),
                "delivery_pct": d.get("delivery_pct"),
                "insider_buy_pct_90d": d.get("insider_buy_pct_90d"),
                "block_deal_net_qty": d.get("block_deal_net_qty"),
                "block_deal_value_cr": d.get("block_deal_value_cr"),
                "block_deal_net_qty_5d": d.get("block_deal_net_qty_5d"),
                "block_deal_value_cr_5d": d.get("block_deal_value_cr_5d"),
                "analyst_buy_pct": d.get("analyst_buy_pct"),
                "analyst_target_mean": d.get("analyst_target_mean"),
                "analyst_target_upside_pct": d.get("analyst_target_upside_pct"),
                "analyst_n": d.get("analyst_n"),
                "broker_recos_90d": d.get("broker_recos_90d"),
                "days_to_next_earnings": d.get("days_to_next_earnings"),
                "days_since_last_earnings": d.get("days_since_last_earnings"),
                "last_eps_surprise_pct": d.get("last_eps_surprise_pct"),
                "last_beat_score": d.get("last_beat_score"),
                "earnings_in_5d": d.get("earnings_in_5d"),
                "delivery_z_20d": d.get("delivery_z_20d"),
                "delivery_pct_chg_5d": d.get("delivery_pct_chg_5d"),
                "delivery_qty_5d": d.get("delivery_qty_5d"),
                "nifty_pcr": d.get("nifty_pcr"),
                "call_wall_dist_pct": d.get("call_wall_dist_pct"),
                "put_wall_dist_pct": d.get("put_wall_dist_pct"),
                "near_expiry_gamma": d.get("near_expiry_gamma"),
                "max_pain": d.get("max_pain"),
                "sector_ret_5d": d.get("sector_ret_5d"),
                "sector_ret_21d": d.get("sector_ret_21d"),
                "nifty_pe": d.get("nifty_pe"),
                "advance_decline_ratio": d.get("advance_decline_ratio"),
                "price_to_book": d.get("price_to_book"),
                "rev_growth": d.get("rev_growth"), "eps_growth": d.get("eps_growth"),
            })
        if rows_to_insert:
            con.executemany(SQL, rows_to_insert)
        return len(rows_to_insert)

    # ── Full pipeline ────────────────────────────────────────────────────────

    def run_full_pipeline(self, symbols: list = None, lookback_days: int = 504,
                          date_filter: str = None) -> None:
        """Run feature engineering for all symbols in parallel using ProcessPoolExecutor.

        date_filter: if 'today', only write today's row per symbol (fast daily mode).
                     Still loads full lookback for accurate indicator computation.
        Workers are read-only (no SQLite writes, no scaler saves). All writes happen
        in the main process sequentially after each worker returns its feature DataFrame.
        """
        clear_global_series_cache()
        con = self._con()
        try:
            if symbols is None:
                rows = con.execute(
                    "SELECT DISTINCT symbol FROM stock_ohlcv "
                    "GROUP BY symbol HAVING COUNT(*) >= 60"
                ).fetchall()
                symbols = [r["symbol"] for r in rows]

            # logical_write_floor(), not datetime.today() (2026-08-08) -- on any non-trading
            # day (weekend/holiday) stock_ohlcv has no row for the raw calendar date, so every
            # symbol's date-filtered write matched zero rows: 2426/2426 symbols "succeeded"
            # (feat computed fine) but wrote 0 rows, tripping the written==0 guard below with
            # no per-symbol cause (there wasn't one -- see run_full_pipeline's own comment on
            # why individual worker errors can never surface). Use the last real trading
            # session's date instead, same fix pattern as dl_engine.py/screener_performance.py.
            only_date = logical_write_floor(con, fallback=datetime.today().strftime("%Y-%m-%d")) if date_filter == "today" else None
            total = len(symbols)
            if total == 0:
                # Was silently a no-op: an empty symbol list (e.g. stock_ohlcv temporarily
                # empty/unreachable) fell straight through the loop below to "Pipeline
                # complete — 0 total rows written" and exit 0, indistinguishable from a
                # healthy day in job_heartbeat/BullMQ. See the 2026-08 job-health
                # investigation: feature_store's MAX(computed_at) was found frozen for
                # weeks with no error anywhere.
                raise RuntimeError(
                    "[FE] No symbols found in stock_ohlcv with >=60 rows — refusing to "
                    "report a silent-empty success."
                )
            print(f"[FE] Processing {total} symbols in parallel{' (today-only mode)' if only_date else ''}...")

            args_list = [(sym, lookback_days, only_date) for sym in symbols]
            num_workers = min(multiprocessing.cpu_count(), 8)

            from itertools import islice
            CHUNK_SIZE = num_workers * 4  # submit only 4 waves ahead of workers
            it = iter(args_list)
            i = 0
            written = 0
            # initializer=_worker_init: each spawned worker redirects its own stdio to
            # DEVNULL so it doesn't hold Node's inherited pipe endpoints open after kill.
            with ProcessPoolExecutor(max_workers=num_workers, initializer=_worker_init) as executor:
                while True:
                    chunk = list(islice(it, CHUNK_SIZE))
                    if not chunk:
                        break
                    fs = {executor.submit(_compute_symbol_unscaled, a): a[0] for a in chunk}
                    for future in as_completed(fs):
                        i += 1
                        symbol = fs[future]
                        try:
                            _, feat = future.result()
                            if feat is not None:
                                try:
                                    n = self._write_symbol_features(symbol, feat, only_date, con)
                                except (OperationalError, PendingRollbackError, InterfaceError) as conn_err:
                                    # con is opened ONCE at the top of this function and reused
                                    # across the whole run; while ProcessPoolExecutor computes a
                                    # chunk of ~32 symbols, con sits idle, and idle long enough it
                                    # can be closed server-side (Postgres/network timeout) without
                                    # pool_pre_ping ever catching it -- pre_ping only validates a
                                    # connection at pool CHECKOUT, and this one was checked out
                                    # once and never returned. Same pattern already fixed in
                                    # strategy_optimizer.py/backtest_optimizer.py (recurring-bugs.md
                                    # "connection checked out once ... left idle"), applied here as
                                    # a retry since writes recur throughout this loop rather than
                                    # happening once at the end. close() itself can also raise (the
                                    # same dead connection) -- discarding it regardless is fine,
                                    # only a failure to open the NEW one is fatal to this symbol.
                                    print(f"[FE] {symbol}: write failed on a possibly-dead "
                                          f"connection ({conn_err}); reconnecting and retrying once")
                                    try:
                                        con.close()
                                    except Exception:
                                        pass
                                    con = self._con()
                                    n = self._write_symbol_features(symbol, feat, only_date, con)
                                written += n
                                if i % 100 == 0:
                                    print(f"[FE] {i}/{total} complete — {written} rows written")
                        except Exception as e:
                            # Must recover the connection, not just log: on Postgres this
                            # statement's failure has aborted the whole transaction, so without
                            # it every remaining symbol dies reporting the abort rather than its
                            # own cause -- which is exactly how one symbol's error became a
                            # whole-run failure on 2026-08-31.
                            if not recover_from_failed_statement(con, symbol, e):
                                try:
                                    con.close()
                                except Exception:
                                    pass
                                con = self._con()
                        if i % 200 == 0:
                            con.commit()

            con.commit()
            # Purge AFTER all writes: a row this run could not produce is one no future run can
            # correct either (its date has no clean bar), so it would otherwise persist forever.
            # Deliberately not run in --date/single-symbol mode, where "rows this run did not
            # produce" is almost everything.
            if not symbols and not date_filter:
                purge_orphan_feature_rows(con)
            print(f"[FE] Pipeline complete — {written} total rows written")
            if written == 0:
                # Every symbol either had <60 rows post-fetch, threw inside
                # _compute_symbol_unscaled/_write_symbol_features (each caught and logged
                # individually above, never surfaced), or was silently skipped -- any of
                # which used to exit 0 with feature_store untouched. Fail loudly instead so
                # this shows up as a real BullMQ/job_heartbeat failure, not a clean "success"
                # that quietly wrote nothing (same class of bug as the total==0 guard above).
                raise RuntimeError(
                    f"[FE] Processed {total} symbols but wrote 0 feature rows — every "
                    "worker failed or returned no data. Refusing to report a silent-empty "
                    "success; see the per-symbol [FE] ERROR lines above for the real cause."
                )
        finally:
            con.close()

    def _process_symbol_date(self, symbol: str, lookback_days: int, target_date: str) -> int:
        """Compute features for one symbol but only write the row for target_date."""
        return self.process_symbol(symbol, lookback_days, only_date=target_date)


def _compute_symbol_unscaled(args: tuple):
    """Compute unscaled feature DataFrame for one symbol.

    Module-level function required for Windows spawn multiprocessing.
    Workers are read-only: no SQLite writes, no scaler saves.

    Returns: (symbol, feat_df) or (symbol, None) on insufficient data/error.
    """
    symbol, lookback_days, only_date = args
    try:
        fe = FeatureEngineer()
        cutoff = (datetime.today() - timedelta(days=lookback_days)).date()
        ohlcv = read_df(
            "SELECT date, open, high, low, close, volume FROM stock_ohlcv "
            "WHERE symbol=? AND date>=? AND COALESCE(is_suspect,0)=0 ORDER BY date",
            (symbol, cutoff),
        )
        if len(ohlcv) < 60:
            return (symbol, None)
        ohlcv["date"] = pd.to_datetime(ohlcv["date"])
        ohlcv = ohlcv.set_index("date")
        feat = fe._compute_ohlcv_features(ohlcv)
        feat = fe._merge_fii(feat)
        feat = fe._merge_fundamentals(feat, symbol)
        feat = fe._merge_macro(feat)
        feat = fe._merge_sentiment(feat, symbol)
        # Gap #4: same exogenous merges as process_symbol -- workers must produce the
        # identical unscaled frame or the two write paths diverge.
        feat = fe._merge_flow_features(feat, symbol)
        feat = fe._merge_deep_history(feat, symbol)
        feat = fe._merge_market_context(feat)
        return (symbol, feat)
    except Exception as e:
        print(f"[FE] ERROR {symbol}: {e}", flush=True)
        return (symbol, None)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", help="Specific symbols (default: all)")
    parser.add_argument("--lookback", type=int, default=504)
    parser.add_argument("--date", help="If 'today', only update today's features (fast mode)")
    args = parser.parse_args()

    fe = FeatureEngineer()
    syms = args.symbols
    fe.run_full_pipeline(symbols=syms, lookback_days=args.lookback, date_filter=args.date)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
