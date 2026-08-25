#!/usr/bin/env python3
"""
Feature engineering pipeline: computes 84 ML-ready features per (symbol, date)
and writes to feature_store. Enforces strict leakage prevention rules.
"""

import sys
import json
import pickle
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
from sklearn.preprocessing import RobustScaler
import ta

from db_compat import connect, read_df, use_postgres, ConnWrapper
from as_of import read_as_of_history, logical_write_floor

SCALER_PATH = Path(__file__).parent / "ml_models" / "feature_scaler_v1.pkl"

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
            "insider_buy_pct_90d", "block_deal_net_qty",
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


class FeatureEngineer:
    def __init__(self):
        self.scaler: Optional[RobustScaler] = None

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
        fii = read_df("SELECT date, fii_net, dii_net FROM fii_dii_flow ORDER BY date")
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
        get NaN, not a leaked current value. fundamentals_history has no trailing_pe column,
        so it's derived from the point-in-time earnings_yield instead.
        """
        hist = read_as_of_history(
            "fundamentals_history", symbol,
            ["return_on_equity", "debt_to_equity", "operating_margins",
             "piotroski_f_score", "earnings_yield",
             # Gap #4: valuation/growth fields present in fundamentals_history but never
             # merged (only the five legacy columns were requested before).
             "price_to_book", "revenue_growth", "earnings_growth"],
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
        # fundamentals_history.earnings_yield mirrors stock_fundamentals.earnings_yield's
        # convention: a PERCENTAGE (e.g. 4.46 meaning 4.46%, so trailing_pe = 100/ey), not a
        # decimal fraction. The old code's "earnings_yield" feature was a decimal 1/pe
        # (~0.02-0.10); ey/100 reproduces that same scale so historical feature_store rows
        # stay comparable to rows written under this fix.
        ey = merged["earnings_yield"]
        feat["earnings_yield"] = ey / 100.0
        feat["trailing_pe"] = np.where(ey.notna() & (ey != 0), 100.0 / ey, np.nan)
        # Gap #4 follow-up (2026-08-24): price_to_book/revenue_growth/earnings_growth were
        # added to the read list above during the Gap #4 fix but never assigned -- fetched
        # every run and silently dropped, leaving the feature_store columns permanently
        # NULL (the same fetched-but-dead shape as the flow columns). revenue_growth /
        # earnings_growth arrive as decimal fractions (RELIANCE 2026-08-21: 0.297 / -0.224);
        # price_to_book is a plain ratio (~1.96).
        feat["price_to_book"] = merged["price_to_book"]
        feat["rev_growth"]    = merged["revenue_growth"]
        feat["eps_growth"]    = merged["earnings_growth"]
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
            df = read_df(
                "SELECT date, ret_5d FROM macro_asset_prices WHERE symbol=? ORDER BY date",
                (sym,),
            )
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date")
            df = df[df.index.notnull()]
            if not df.empty:
                feat[col] = df["ret_5d"].reindex(feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS)

        # Nifty metrics
        nifty = read_df("SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' ORDER BY date")
        nifty["date"] = pd.to_datetime(nifty["date"])
        nifty = nifty.set_index("date")
        nifty = nifty[nifty.index.notnull()]
        if not nifty.empty:
            feat["nifty_ret_5d"]  = nifty["close"].pct_change(5).reindex(feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS)
            feat["nifty_ret_21d"] = nifty["close"].pct_change(21).reindex(feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS)

        # India VIX from macro_asset_prices (true implied-vol index; was a weak NSEBANK proxy)
        vix_df = read_df("SELECT date, close FROM macro_asset_prices WHERE symbol='INDIAVIX' ORDER BY date")
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
        "delivery_pct", "pcr_oi", "pcr_vol", "iv_rank", "iv_skew",
        "insider_buy_pct_90d", "block_deal_net_qty",
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

    def _merge_market_context(self, feat: pd.DataFrame) -> pd.DataFrame:
        """Market-level regime context: NIFTY50 P/E (index_valuation) and the
        advance/decline ratio (market_breadth).

        Unlike the per-symbol flow fields these are published every trading day and remain
        meaningful across a weekend/holiday gap, so they use the same bounded reindex-ffill
        as the macro merges (FFILL_LIMIT_DAYS caps how stale a carried value may get).
        """
        pe = read_df(
            "SELECT date, pe FROM index_valuation WHERE index_name='NIFTY50' ORDER BY date"
        )
        if not pe.empty:
            pe["date"] = pd.to_datetime(pe["date"])
            pe = pe.set_index("date")
            pe = pe[pe.index.notnull()]
            feat["nifty_pe"] = pe["pe"].reindex(
                feat.index, method="ffill", limit=self.FFILL_LIMIT_DAYS
            )

        breadth = read_df(
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

    # ── Normalization ────────────────────────────────────────────────────────

    def _fit_scaler(self, feat: pd.DataFrame, train_frac: float = 0.8) -> RobustScaler:
        """Fit RobustScaler on first train_frac of dates only (no leakage)."""
        numeric_cols = feat.select_dtypes(include=[np.number]).columns.tolist()
        cutoff = max(1, int(len(feat) * train_frac))
        train_slice = feat.iloc[:cutoff][numeric_cols].fillna(0)
        scaler = RobustScaler()
        scaler.fit(train_slice)
        return scaler

    def _apply_scaler(self, feat: pd.DataFrame, scaler: RobustScaler) -> pd.DataFrame:
        numeric_cols = feat.select_dtypes(include=[np.number]).columns.tolist()
        # log1p volume ratios before scaling
        for col in ["volume_ratio_5d", "volume_ratio_20d"]:
            if col in feat:
                feat[col] = np.log1p(feat[col].clip(lower=0))
        feat[numeric_cols] = scaler.transform(feat[numeric_cols].fillna(0))
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
            feat = self._merge_market_context(feat)

            # Fit scaler on training window, apply to all
            scaler = self._fit_scaler(feat)
            SCALER_PATH.parent.mkdir(parents=True, exist_ok=True)
            with open(SCALER_PATH, "wb") as f:
                pickle.dump(scaler, f)
            feat = self._apply_scaler(feat, scaler)

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
                        insider_buy_pct_90d, block_deal_net_qty,
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
                        :insider_buy_pct_90d,:block_deal_net_qty,
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
                d = row.to_dict()
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
                    insider_buy_pct_90d, block_deal_net_qty,
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
                    :insider_buy_pct_90d,:block_deal_net_qty,
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
            d = row.to_dict()
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
            last_scaler = None
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
                                scaler = self._fit_scaler(feat)
                                feat = self._apply_scaler(feat, scaler)
                                last_scaler = scaler
                                n = self._write_symbol_features(symbol, feat, only_date, con)
                                written += n
                                if i % 100 == 0:
                                    print(f"[FE] {i}/{total} complete — {written} rows written")
                        except Exception as e:
                            print(f"[FE] ERROR processing {symbol}: {e}")
                        if i % 200 == 0:
                            con.commit()

            if last_scaler is not None:
                SCALER_PATH.parent.mkdir(parents=True, exist_ok=True)
                with open(SCALER_PATH, "wb") as f:
                    pickle.dump(last_scaler, f)

            con.commit()
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
