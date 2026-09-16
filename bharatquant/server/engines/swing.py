"""Swing engine — 1–4 week horizon composite.
Factors (all D-1 point-in-time from daily bars + fundamentals + valuation percentiles):
  momentum        : ret_1d/5d/21d balanced against mean-reversion (negative weights on
                    5d/21d z-scores — the platform's data shows intraday AND multi-day
                    strength fade; the RANK uses a mean-reverted blend)
  trend           : trailing 1y linear-regression slope sign + 200SMA alignment + ADX
  ta_support      : RSI(14) in 40-70 band, MACD hist positive, close > SMA50
  value           : valuation score from PE/PB percentile vs own 3y history
  delivery        : 5d delivery% momentum
  size            : minimum turnover + price filters (no score contribution)
Final score = 0..100 weighted blend; stop/entry/target = entry-2.5*ATR14 / entry+4*ATR14.
"""
import numpy as np
import pandas as pd

from .indicators import (sma, ema, rsi, macd, adx, atr, roc)


def _atr_s(x: pd.DataFrame) -> pd.Series:
    pc = x["close"].shift(1)
    tr = pd.concat([(x["high"] - x["low"]), (x["high"] - pc).abs(), (x["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / 14, adjust=False).mean()


def _apply_per_symbol(df: pd.DataFrame, fn) -> pd.Series:
    """Groupby-free per-symbol transform that preserves a plain symbol index."""
    out = pd.Series(index=df.index, dtype=float)
    for sym, x in df.groupby("symbol", sort=False):
        idx = x.index
        out.loc[idx] = fn(x)
    return out


def build_features(daily: pd.DataFrame, univ: pd.DataFrame | None = None,
                   fund: pd.DataFrame | None = None, val: pd.DataFrame | None = None) -> pd.DataFrame:
    df = daily.sort_values(["symbol", "date"]).copy()
    if len(df) == 0:
        return df
    g = df.groupby("symbol", sort=False)
    df["prev_close"] = g["close"].shift(1)
    df["ret_1d"] = g["close"].pct_change()
    df["ret_5d"] = g["close"].pct_change(5)
    df["ret_21d"] = g["close"].pct_change(21)
    df["ret_63d"] = g["close"].pct_change(63)
    df["rsi14"] = _apply_per_symbol(df, lambda x: rsi(x["close"], 14))
    df["sma50"] = _apply_per_symbol(df, lambda x: sma(x["close"], 50))
    df["sma200"] = _apply_per_symbol(df, lambda x: sma(x["close"], 200))
    df["macd"] = _apply_per_symbol(df, lambda x: macd(x["close"])["macd"])
    df["macd_hist"] = _apply_per_symbol(df, lambda x: macd(x["close"])["macd_hist"])
    df["above_sma200"] = (df["close"] > df["sma200"]).astype(int)
    df["vol_ma20"] = g["volume"].transform(lambda s: s.rolling(20, min_periods=10).mean())
    df["atr14"] = _apply_per_symbol(df, _atr_s)
    df["turnover_20d"] = (df["close"] * df["volume"]).groupby(df["symbol"]).transform(
        lambda s: s.rolling(20, min_periods=10).mean())

    # trailing 1y trend slope (fraction of price per day, evaluated on latest row)
    slopes = {}
    for sym, x in df.groupby("symbol", sort=False):
        x = x.sort_values("date")
        win = x.tail(252)
        if len(win) < 120:
            slopes[sym] = 0.0
            continue
        b = np.polyfit(np.arange(len(win)), win["close"].values, 1)[0]
        slopes[sym] = b / win["close"].iloc[-1]
    df["slope_1y"] = df["symbol"].map(slopes)

    adx_vals = {}
    for sym, x in df.groupby("symbol", sort=False):
        x = x.sort_values("date")
        if len(x) > 40:
            adx_vals[sym] = adx(x["close"], x["high"], x["low"], 14)
    df["adx"] = df["symbol"].map(adx_vals)

    if univ is not None and len(univ):
        df = df.merge(univ[["symbol", "sector", "is_asm", "gsm_stage"]], on="symbol", how="left")
    if fund is not None and len(fund):
        df = df.merge(fund, on="symbol", how="left")
    if val is not None and len(val):
        df = df.merge(val, on="symbol", how="left")
    return df


def _atr_s(x: pd.DataFrame) -> pd.Series:
    pc = x["close"].shift(1)
    tr = pd.concat([(x["high"] - x["low"]), (x["high"] - pc).abs(), (x["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / 14, adjust=False).mean()


def score(df: pd.DataFrame) -> pd.DataFrame:
    """Latest-row scoring. df must contain build_features output."""
    if len(df) == 0:
        return df
    latest = df.groupby("symbol", as_index=False).tail(1).copy()
    latest = latest.replace([np.inf, -np.inf], np.nan)

    def z(s):
        s = s.dropna()
        return (s - s.median()) / (1.4826 * (s - s.median()).abs().mean() + 1e-9)

    # momentum: 1d positive, 5d/21d mean-reverted (evidence: strength fades)
    m = (z(latest["ret_1d"]) + 0.5 * z(-latest["ret_5d"]) + 0.3 * z(-latest["ret_21d"]))
    latest["m_score"] = m.rank(pct=True) * 100

    # trend
    t = (100 * latest["slope_1y"]).clip(-1.5, 1.5)
    latest["t_score"] = ((t + 1.5) / 3.0 * 50 + 50 * latest["above_sma200"]).rank(pct=True) * 100

    # TA support
    rsi_ok = latest["rsi14"].between(40, 70)
    macd_ok = latest["macd_hist"] > 0
    sma_ok = latest["close"] > latest["sma50"]
    latest["ta_score"] = (100 * (rsi_ok.astype(int) + macd_ok.astype(int) + sma_ok.astype(int)) / 3)

    # value
    if "pe_pct" in latest.columns:
        pe_term = latest["pe_pct"].clip(0, 1) * 100
        v = (60 - (pe_term - 50)) if False else (100 - pe_term)
        latest["v_score"] = v.clip(0, 100)
    else:
        latest["v_score"] = 50.0

    # delivery
    if "delivery_pct" in latest.columns:
        dv = z(latest["delivery_pct"])
        latest["d_score"] = (100 * dv.clip(-2, 2) + 100).clip(0, 100)
    else:
        latest["d_score"] = 50.0

    latest["final"] = (0.40 * latest["m_score"] + 0.25 * latest["t_score"] +
                       0.15 * latest["ta_score"] + 0.10 * latest["v_score"] +
                       0.10 * latest["d_score"]).round(1).fillna(0.0)
    latest["bq_rank"] = latest["final"].rank(ascending=False, method="min").astype(int)
    latest["stop"] = latest["close"] - latest["atr14"] * 2.5
    latest["target"] = latest["close"] + latest["atr14"] * 4.0
    latest["risk_reward"] = (latest["target"] - latest["close"]) / (latest["close"] - latest["stop"] + 1e-9)
    return latest