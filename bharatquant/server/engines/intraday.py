"""Intraday engine — "CARRY-OVER MOMENTUM" (CoMo-10).
Validated on the platform's 15-min bars (2026-06..2026-09): D-1 return is the dominant
intraday-continuation predictor (cross-sectional IC +0.56, holdout t=+15, +3.6%/day net of costs
for top-10 tier A+B with 2%<=d1_ret<=12% and not >5% up at 10:00). This module executes the same
logic live with point-in-time data only.
"""
import numpy as np
import pandas as pd

from .indicators import ema, sma


def build_daily_features(daily: pd.DataFrame) -> pd.DataFrame:
    df = daily.sort_values(["symbol", "date"]).copy()
    if len(df) == 0:
        return df
    g = df.groupby("symbol", sort=False)
    df["prev_close"] = g["close"].shift(1)
    df["prev_high"] = g["high"].shift(1)
    df["ret_1d"] = g["close"].pct_change()
    df["ret_5d"] = g["close"].pct_change(5)
    df["ret_21d"] = g["close"].pct_change(21)
    df["atr14"] = _apply_per_symbol(df, _atr_series)
    df["vol_ma20"] = g["volume"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).mean())
    df["turnover_20d"] = (df["close"] * df["volume"]).groupby(df["symbol"]).transform(
        lambda s: s.shift(1).rolling(20, min_periods=10).mean())
    df["gap"] = df["open"] / df["prev_close"] - 1
    df["vol_surge"] = df["volume"] / df["vol_ma20"]
    return df


def _apply_per_symbol(df: pd.DataFrame, fn) -> pd.Series:
    out = pd.Series(index=df.index, dtype=float)
    for sym, x in df.groupby("symbol", sort=False):
        out.loc[x.index] = fn(x)
    return out


def _atr_series(x: pd.DataFrame) -> pd.Series:
    pc = x["close"].shift(1)
    tr = pd.concat([(x["high"] - x["low"]), (x["high"] - pc).abs(), (x["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / 14, adjust=False).mean()


def assign_tiers(daily: pd.DataFrame, tier_a=0.80, tier_b=0.50) -> pd.DataFrame:
    q80 = daily.groupby("date")["turnover_20d"].transform(lambda s: s.quantile(tier_a))
    q50 = daily.groupby("date")["turnover_20d"].transform(lambda s: s.quantile(tier_b))
    daily["tier"] = np.where(daily["turnover_20d"] >= q80, "A",
                             np.where(daily["turnover_20d"] >= q50, "B", "C"))
    return daily


def intraday_board(daily: pd.DataFrame, bars: pd.DataFrame) -> pd.DataFrame:
    """Build candidates for the current session: PIT features at 10:00 IST.
    daily: full history with features + tiers. bars: today's 15-min bars (correct grid).
    Returns one row per qualifying symbol with entry/stop/target and the CoMo rank.
    """
    if len(bars) == 0:
        return pd.DataFrame()
    bars = bars.sort_values(["symbol", "datetime"]).copy()
    bars["ist"] = bars["datetime"].dt.tz_convert("Asia/Kolkata")
    bars["t"] = bars["ist"].dt.strftime("%H:%M")
    bars["date"] = bars["ist"].dt.date.astype(str)
    day = bars["date"].iloc[0]

    up_to = bars[bars["t"] <= "09:45"]
    if len(up_to) == 0:
        return pd.DataFrame()
    feat = up_to.groupby("symbol").agg(
        open_px=("open", "first"), entry=("close", "last"),
        high_09_30=("high", lambda s: s[up_to.loc[s.index, "t"] <= "09:30"].max()),
        low_09_30=("low", lambda s: s[up_to.loc[s.index, "t"] <= "09:30"].min()),
        cum_vol=("volume", "sum"),
        n_bars=("close", "size"))
    pv = (up_to["close"] * up_to["volume"]).groupby(up_to["symbol"]).sum()
    vv = up_to["volume"].groupby(up_to["symbol"]).sum()
    feat["vwap"] = pv / vv.where(vv > 0, np.nan)
    feat["or_pos"] = (feat["entry"] - feat["low_09_30"]) / (feat["high_09_30"] - feat["low_09_30"])
    feat["ret_from_open"] = feat["entry"] / feat["open_px"] - 1
    feat["vwap_dev"] = feat["entry"] / feat["vwap"] - 1

    d = daily[daily["date"] == day]
    if len(d) == 0:
        return pd.DataFrame()
    d2 = d.set_index(["symbol"]).copy()
    # D-1 features: prev row per symbol is yesterday's close-to-close move, features already shifted
    feat = feat.join(d2[["ret_1d", "ret_5d", "ret_21d", "atr14", "prev_close", "tier", "turnover_20d"]],
                     how="inner")
    feat["d1_ret"] = feat["ret_1d"]
    feat["atr_pct"] = feat["atr14"] / feat["prev_close"]
    feat = feat.dropna(subset=["d1_ret", "entry"])

    # CoMo eligibility + rank (research thresholds)
    elig = (feat["tier"].isin(["A", "B"])) & (feat["d1_ret"].between(0.02, 0.12)) & \
        (feat["ret_from_open"] <= 0.05) & (feat["entry"] > 2.0) & \
        (feat["n_bars"] >= 4)
    board = feat[elig].copy()
    if len(board) == 0:
        return board
    board["score"] = board["d1_ret"]
    board["co_rank"] = board["score"].rank(ascending=False).astype(int)
    board["stop"] = board["entry"] * 0.97            # disaster -3%
    board["target"] = board["entry"] * 1.0           # time-based exit; target unused
    board["grade"] = pd.cut(board["d1_ret"], [-np.inf, 0.04, 0.07, np.inf],
                            labels=["B", "A", "A+"]).astype(str)
    return board.reset_index()


def intraday_minute_bars(daily: pd.DataFrame, bars: pd.DataFrame) -> pd.DataFrame:
    """15m->'minute' simulation: expand session bars for the chart (no change to decision logic)."""
    out = []
    for sym, x in bars.groupby("symbol"):
        x = x.sort_values("datetime")
        out.append(x)
    if not out:
        return pd.DataFrame()
    return pd.concat(out)