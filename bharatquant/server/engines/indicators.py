"""Technical indicators computed from pandas OHLCV frames (custom implementations,
plain pandas so any environment can reproduce them; vectorized).
"""
import numpy as np
import pandas as pd

EPS = 1e-12


def sma(s: pd.Series, w: int) -> pd.Series:
    return s.rolling(w, min_periods=w).mean()


def ema(s: pd.Series, w: int) -> pd.Series:
    return s.ewm(span=w, adjust=False).mean()


def rsi(close: pd.Series, w: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / w, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / w, adjust=False).mean()
    return 100 - 100 / (1 + up / (dn + EPS))


def macd(close: pd.Series, fast=12, slow=26, sig=9) -> pd.DataFrame:
    ema_f, ema_s = ema(close, fast), ema(close, slow)
    line = ema_f - ema_s
    sigl = line.ewm(span=sig, adjust=False).mean()
    return pd.DataFrame({"macd": line, "macd_signal": sigl, "macd_hist": line - sigl})


def atr(high: pd.Series, low: pd.Series, close: pd.Series, w: int = 14) -> pd.Series:
    pc = close.shift(1)
    tr = pd.concat(
        [(high - low), (high - pc).abs(), (low - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / w, adjust=False).mean()


def bollinger(close: pd.Series, w: int = 20, k: float = 2.0) -> pd.DataFrame:
    m = sma(close, w)
    sd = close.rolling(w, min_periods=w).std(ddof=0)
    return pd.DataFrame(
        {"bb_mid": m, "bb_upper": m + k * sd, "bb_lower": m - k * sd, "bb_width": (2 * k * sd) / m})


def adx(close: pd.Series, high: pd.Series, low: pd.Series, w: int = 14) -> float:
    """ADX = 100 * |EMA_w(PosDI) - EMA_w(NegDI)| / (EMA_w(PosDI) + EMA_w(NegDI))."""
    up = high.diff()
    dn = -low.diff()
    p = (up * (up > dn)).clip(lower=0)
    n = (dn * (dn > up)).clip(lower=0)
    de = np.hypot(high.diff(), low.diff())
    pos = ema(p, w) / (ema(de, w) + EPS)
    neg = ema(n, w) / (ema(de, w) + EPS)
    return float((100 * (pos - neg).abs() / (pos + neg + EPS)).iloc[-1])


def stochastic(close: pd.Series, high: pd.Series, low: pd.Series, w: int = 14) -> float:
    h, l = high.rolling(w, min_periods=w).max(), low.rolling(w, min_periods=w).min()
    rng = (h - l).replace(0, np.nan)
    return float(((close - l) / rng * 100).iloc[-1])


def roc(s: pd.Series, w: int) -> pd.Series:
    return s.pct_change(w)


def true_range_fraction(high: pd.Series, low: pd.Series, close: pd.Series, w: int = 10) -> float:
    return float((atr(high, low, close, w) / close).iloc[-1])


def vwap(o, h, l, c, v) -> pd.Series:
    return (v * (o + h + l + c) / 4).cumsum() / (v.cumsum() + EPS)


def linear_reg_slope(s: pd.Series, w: int) -> float:
    x = np.arange(w)
    y = s.tail(w).values
    if len(y) < w:
        return 0.0
    b = np.polyfit(x, y, 1)[0]
    return float(b / s.iloc[-1])  # slope as fraction of price


def zscore(s: pd.Series, w: int = 20) -> pd.Series:
    m = s.rolling(w, min_periods=w).mean()
    sd = s.rolling(w, min_periods=w).std(ddof=0)
    return (s - m) / (sd + EPS)