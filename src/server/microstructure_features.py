"""Microstructure Features for Indian Equity Markets.

Computes OFI, VPIN, VWAP z-score, and relative volume features
from OHLCV data available in stock_ohlcv and technical_signals.

Usage:
    from microstructure_features import compute_microstructure_features
    df = compute_microstructure_features(df, ohlcv_loader)
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from typing import Callable, Optional


def compute_order_flow_imbalance(
    df: pd.DataFrame,
    window: int = 20,
    price_col: str = "close",
    volume_col: str = "volume",
) -> pd.Series:
    """Order Flow Imbalance: cumulative signed volume over window.

    OFI_t = sum(sign(price_change) * volume) over last window bars.
    Positive OFI = buying pressure, negative = selling pressure.

    This is a daily proxy for true tick-level OFI. For intraday OFI,
    use 1-min or 5-min bar data.
    """
    if price_col not in df.columns or volume_col not in df.columns:
        return pd.Series(np.nan, index=df.index)
    price_diff = df[price_col].diff()
    signed_vol = np.sign(price_diff) * df[volume_col]
    ofi = signed_vol.rolling(window=window, min_periods=1).sum()
    # Normalize by total volume to make cross-section comparable
    total_vol = df[volume_col].rolling(window=window, min_periods=1).sum()
    ofi_pct = ofi / total_vol.replace(0, np.nan)
    return ofi_pct.fillna(0.0)


def compute_vpin(
    df: pd.DataFrame,
    n_buckets: int = 50,
    volume_col: str = "volume",
    high_col: str = "high",
    low_col: str = "low",
) -> pd.Series:
    """Volume-Synchronized Probability of Informed Trading (VPIN).

    Simplified daily approximation using OHLCV:
    - Volume imbalance per bar = |2*close - high - low| / (high - low + epsilon)
      (proxies close-to-range ratio as buy/sell pressure indicator)
    - VPN = rolling mean of volume imbalance over n_buckets bars

    True VPIN requires volume-clock bucketing; this is a daily-bar proxy.
    """
    if not all(c in df.columns for c in [volume_col, high_col, low_col]):
        return pd.Series(np.nan, index=df.index)
    hl_range = (df[high_col] - df[low_col]).replace(0, np.nan)
    close_position = (2 * df.get("close", (df[high_col] + df[low_col]) / 2) - df[high_col] - df[low_col]) / hl_range
    vol_imbalance = close_position.abs().fillna(0.0)
    vpin = vol_imbalance.rolling(window=n_buckets, min_periods=1).mean()
    return vpin.fillna(0.0)


def compute_vwap_zscore(
    df: pd.DataFrame,
    lookback: int = 20,
    close_col: str = "close",
    vwap_dev_col: str = "vwap_deviation_pct",
) -> pd.Series:
    """VWAP z-score: normalized deviation from VWAP.

    Uses existing vwap_deviation_pct if available, otherwise
    computes z-score of the deviation itself.
    """
    if vwap_dev_col not in df.columns:
        return pd.Series(np.nan, index=df.index)
    dev = df[vwap_dev_col]
    mean_dev = dev.rolling(window=lookback, min_periods=1).mean()
    std_dev = dev.rolling(window=lookback, min_periods=1).std().replace(0, np.nan)
    zscore = (dev - mean_dev) / std_dev
    return zscore.fillna(0.0)


def compute_relative_volume(
    df: pd.DataFrame,
    volume_col: str = "volume",
    avg_window: int = 20,
) -> pd.Series:
    """Relative volume: current volume / average volume over window.

    This is a cross-section-agnostic version. For time-of-day
    relative volume, intraday data is required.
    """
    if volume_col not in df.columns:
        return pd.Series(np.nan, index=df.index)
    avg_vol = df[volume_col].rolling(window=avg_window, min_periods=1).mean()
    rel_vol = df[volume_col] / avg_vol.replace(0, np.nan)
    return rel_vol.fillna(1.0)


def compute_microstructure_features(
    df: pd.DataFrame,
    ohlcv_loader: Optional[Callable] = None,
) -> pd.DataFrame:
    """Compute all microstructure features and add to dataframe.

    Args:
        df: DataFrame with at minimum close, volume columns
        ohlcv_loader: Optional callable(symbol, date, lookback) -> DataFrame
                      with daily OHLCV for more accurate computation

    Returns:
        DataFrame with added microstructure columns:
        - ofi_20: 20-period order flow imbalance
        - vpin_50: 50-period VPIN proxy
        - vwap_zscore_20: 20-period VWAP z-score
        - rel_vol_20: 20-period relative volume
    """
    result = df.copy()

    # OFI
    result["ofi_20"] = compute_order_flow_imbalance(df, window=20)

    # VPIN
    result["vpin_50"] = compute_vpin(df, n_buckets=50)

    # VWAP z-score
    result["vwap_zscore_20"] = compute_vwap_zscore(df, lookback=20)

    # Relative volume
    result["rel_vol_20"] = compute_relative_volume(df, avg_window=20)

    return result
