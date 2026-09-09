"""Microstructure Signals for Intraday Trading.

Implements Order Flow Imbalance (OFI), Volume-Synchronized Probability of
Informed Trading (VPIN), and VWAP deviation bands for intraday alpha.

Usage:
    from microstructure_signals import (
        compute_ofi,
        compute_vpin,
        compute_vwap_bands,
        MicrostructureFeatures,
    )
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from typing import Optional


def compute_ofi(
    df: pd.DataFrame,
    price_col: str = "close",
    volume_col: str = "volume",
    window: int = 5,
) -> pd.Series:
    """Compute Order Flow Imbalance (OFI) as a proxy for informed flow.

    Uses signed volume as a proxy: positive when price rises, negative when falls.
    This is a simplified OFI that approximates the true OFI which requires
    Level 2 order book data.

    Args:
        df: DataFrame with price and volume columns
        price_col: Name of price column
        volume_col: Name of volume column
        window: Rolling window for OFI accumulation

    Returns:
        Series of OFI values (normalized z-score if enough data)
    """
    if df.empty or price_col not in df.columns or volume_col not in df.columns:
        return pd.Series(dtype=float)

    # Signed volume: +volume on up moves, -volume on down moves
    price_diff = df[price_col].diff()
    signed_volume = np.sign(price_diff) * df[volume_col]

    # Rolling OFI
    ofi = signed_volume.rolling(window=window, min_periods=1).sum()

    # Normalize to z-score if enough data
    ofi_mean = ofi.rolling(window=window * 5, min_periods=window).mean()
    ofi_std = ofi.rolling(window=window * 5, min_periods=window).std()
    ofi_zscore = (ofi - ofi_mean) / ofi_std.replace(0, np.nan)

    return ofi_zscore.fillna(0.0)


def compute_vpin(
    df: pd.DataFrame,
    volume_col: str = "volume",
    price_col: str = "close",
    window: int = 50,
) -> pd.Series:
    """Compute Volume-Synchronized Probability of Informed Trading (VPIN).

    VPIN estimates the fraction of volume that comes from informed traders.
    High VPIN suggests elevated information asymmetry (potential volatility).

    Args:
        df: DataFrame with volume and price columns
        volume_col: Name of volume column
        price_col: Name of price column
        window: Rolling window for VPIN calculation

    Returns:
        Series of VPIN values (0 to 1)
    """
    if df.empty or volume_col not in df.columns or price_col not in df.columns:
        return pd.Series(dtype=float)

    # Estimate buy/sell volume from price direction
    price_diff = df[price_col].diff()
    buy_volume = df[volume_col].where(price_diff > 0, 0)
    sell_volume = df[volume_col].where(price_diff < 0, 0)
    # For unchanged price, split evenly
    unchanged = price_diff == 0
    buy_volume = buy_volume.where(~unchanged, df[volume_col] / 2)
    sell_volume = sell_volume.where(~unchanged, df[volume_col] / 2)

    # Volume imbalance
    total_volume = buy_volume + sell_volume
    volume_imbalance = np.abs(buy_volume - sell_volume) / total_volume.replace(0, np.nan)

    # Rolling VPIN (average volume imbalance over window)
    vpin = volume_imbalance.rolling(window=window, min_periods=1).mean()

    return vpin.fillna(0.0)


def compute_vwap(
    df: pd.DataFrame,
    high_col: str = "high",
    low_col: str = "low",
    close_col: str = "close",
    volume_col: str = "volume",
) -> pd.Series:
    """Compute Volume-Weighted Average Price (VWAP).

    Uses typical price = (high + low + close) / 3.

    Args:
        df: DataFrame with OHLCV data
        high_col: Name of high price column
        low_col: Name of low price column
        close_col: Name of close price column
        volume_col: Name of volume column

    Returns:
        Series of VWAP values (cumulative)
    """
    if df.empty:
        return pd.Series(dtype=float)

    required = [high_col, low_col, close_col, volume_col]
    if not all(c in df.columns for c in required):
        return pd.Series(dtype=float)

    typical_price = (df[high_col] + df[low_col] + df[close_col]) / 3
    tp_vol = typical_price * df[volume_col]

    # Cumulative VWAP
    cum_tp_vol = tp_vol.cumsum()
    cum_vol = df[volume_col].cumsum()

    vwap = cum_tp_vol / cum_vol.replace(0, np.nan)
    return vwap.ffill()


def compute_vwap_bands(
    df: pd.DataFrame,
    high_col: str = "high",
    low_col: str = "low",
    close_col: str = "close",
    volume_col: str = "volume",
    num_std: float = 1.0,
    window: int = 20,
) -> pd.DataFrame:
    """Compute VWAP deviation bands (Bollinger-style around VWAP).

    Args:
        df: DataFrame with OHLCV data
        num_std: Number of standard deviations for bands
        window: Rolling window for standard deviation

    Returns:
        DataFrame with columns: vwap, vwap_upper, vwap_lower, vwap_dev_pct, vwap_zscore
    """
    if df.empty:
        return pd.DataFrame()

    vwap = compute_vwap(df, high_col, low_col, close_col, volume_col)

    # Deviation from VWAP
    vwap_dev = df[close_col] - vwap
    vwap_dev_pct = vwap_dev / vwap.replace(0, np.nan)

    # Rolling standard deviation of deviation
    rolling_std = vwap_dev.rolling(window=window, min_periods=1).std()

    # Bands
    vwap_upper = vwap + num_std * rolling_std
    vwap_lower = vwap - num_std * rolling_std

    # Z-score of deviation
    vwap_zscore = vwap_dev / rolling_std.replace(0, np.nan)

    return pd.DataFrame({
        "vwap": vwap,
        "vwap_upper": vwap_upper,
        "vwap_lower": vwap_lower,
        "vwap_dev_pct": vwap_dev_pct,
        "vwap_zscore": vwap_zscore,
    })


def compute_volume_imbalance(
    df: pd.DataFrame,
    volume_col: str = "volume",
    price_col: str = "close",
    window: int = 10,
) -> pd.Series:
    """Compute volume imbalance (buy vs sell pressure).

    Returns positive values for buy pressure, negative for sell pressure.

    Args:
        df: DataFrame with volume and price
        volume_col: Volume column name
        price_col: Price column name
        window: Rolling window

    Returns:
        Series of volume imbalance values
    """
    if df.empty or volume_col not in df.columns or price_col not in df.columns:
        return pd.Series(dtype=float)

    price_diff = df[price_col].diff()
    signed_volume = np.sign(price_diff) * df[volume_col]
    imbalance = signed_volume.rolling(window=window, min_periods=1).sum()

    # Normalize by total volume
    total_vol = df[volume_col].rolling(window=window, min_periods=1).sum()
    normalized = imbalance / total_vol.replace(0, np.nan)

    return normalized.fillna(0.0)


def compute_kyle_lambda(
    df: pd.DataFrame,
    price_col: str = "close",
    volume_col: str = "volume",
    window: int = 20,
) -> pd.Series:
    """Estimate Kyle's Lambda (price impact coefficient).

    Measures how much price moves per unit of order flow.
    Higher lambda = more illiquid / more price impact.

    Args:
        df: DataFrame with price and volume
        price_col: Price column name
        volume_col: Volume column name
        window: Rolling window for regression

    Returns:
        Series of Kyle's Lambda estimates
    """
    if df.empty or len(df) < 2:
        return pd.Series(dtype=float)

    price_diff = df[price_col].diff()
    signed_volume = np.sign(price_diff) * df[volume_col]

    # Rolling regression: |price_diff| = lambda * |signed_volume|
    abs_price_diff = price_diff.abs()
    abs_signed_volume = signed_volume.abs()

    # Rolling covariance / variance
    cov = abs_price_diff.rolling(window).cov(abs_signed_volume)
    var = abs_signed_volume.rolling(window).var()

    kyle_lambda = cov / var.replace(0, np.nan)
    return kyle_lambda.fillna(0.0)


class MicrostructureFeatures:
    """Compute and store microstructure features for a symbol."""

    def __init__(
        self,
        ofi_window: int = 5,
        vpin_window: int = 50,
        vwap_band_std: float = 1.0,
        vwap_band_window: int = 20,
    ):
        self.ofi_window = ofi_window
        self.vpin_window = vpin_window
        self.vwap_band_std = vwap_band_std
        self.vwap_band_window = vwap_band_window

    def compute_all(self, df: pd.DataFrame) -> pd.DataFrame:
        """Compute all microstructure features.

        Args:
            df: DataFrame with OHLCV data

        Returns:
            DataFrame with microstructure features added
        """
        result = df.copy()

        # OFI
        result["ofi_zscore"] = compute_ofi(df, window=self.ofi_window)

        # VPIN
        result["vpin"] = compute_vpin(df, window=self.vpin_window)

        # VWAP bands
        vwap_df = compute_vwap_bands(
            df,
            num_std=self.vwap_band_std,
            window=self.vwap_band_window,
        )
        for col in vwap_df.columns:
            result[col] = vwap_df[col]

        # Volume imbalance
        result["volume_imbalance"] = compute_volume_imbalance(df)

        # Kyle's Lambda
        result["kyle_lambda"] = compute_kyle_lambda(df)

        return result
