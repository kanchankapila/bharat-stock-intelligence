"""Trend-Scanning Labels for Medium-Term Horizons.

An alternative to the Triple Barrier method that identifies the start and end
of sustained moves using running maxima/minima with drawdown constraints.

Reference: López de Prado, "Advances in Financial Machine Learning" (2018)
"""
from __future__ import annotations
import numpy as np
from typing import Optional


def trend_scanning_label(
    prices: np.ndarray,
    min_trend_days: int = 3,
    max_hold_days: int = 20,
    max_drawdown_pct: float = 0.10,
) -> int:
    """Determine if a sustained trend starts at index 0.

    Label = 1 if uptrend starts and continues for min_trend_days without >max_drawdown_pct drawdown
    Label = -1 if downtrend starts and continues for min_trend_days without >max_drawdown_pct rally
    Label = 0 otherwise (no clear trend or trend violates conditions)

    Args:
        prices: Array of close prices, ascending by date
        min_trend_days: Minimum consecutive days in trend direction
        max_hold_days: Maximum holding period
        max_drawdown_pct: Maximum allowed drawdown (for longs) or rally (for shorts)

    Returns:
        Label: 1 (uptrend), -1 (downtrend), or 0 (no clear trend)
    """
    if len(prices) < min_trend_days + 1:
        return 0

    # Check for uptrend: consecutive up days without >max_drawdown drawdown
    up_streak = 0
    peak = prices[0]
    for i in range(1, min(len(prices), max_hold_days + 1)):
        if prices[i] > prices[i - 1]:
            up_streak += 1
            peak = max(peak, prices[i])
            if up_streak >= min_trend_days:
                return 1
        else:
            drawdown = (peak - prices[i]) / peak if peak > 0 else 0
            if drawdown > max_drawdown_pct:
                break
            up_streak = 0

    # Check for downtrend: consecutive down days without >max_drawdown rally
    down_streak = 0
    trough = prices[0]
    for i in range(1, min(len(prices), max_hold_days + 1)):
        if prices[i] < prices[i - 1]:
            down_streak += 1
            trough = min(trough, prices[i])
            if down_streak >= min_trend_days:
                return -1
        else:
            rally = (prices[i] - trough) / trough if trough > 0 else 0
            if rally > max_drawdown_pct:
                break
            down_streak = 0

    return 0


def trend_scanning_labels_batch(
    ohlcv_list: list[dict],
    min_trend_days: int = 3,
    max_hold_days: int = 20,
    max_drawdown_pct: float = 0.10,
) -> list[int]:
    """Compute trend-scanning labels for a list of OHLCV bars.

    Args:
        ohlcv_list: List of dicts with at least a "close" key, ascending by date
        min_trend_days: Minimum consecutive days in trend direction
        max_hold_days: Maximum holding period
        max_drawdown_pct: Maximum allowed drawdown/rally

    Returns:
        List of labels (1, -1, or 0)
    """
    prices = np.array([bar["close"] for bar in ohlcv_list])
    labels = []
    for i in range(len(prices)):
        window = prices[i:i + max_hold_days + 1]
        label = trend_scanning_label(
            window,
            min_trend_days=min_trend_days,
            max_hold_days=max_hold_days,
            max_drawdown_pct=max_drawdown_pct,
        )
        labels.append(label)
    return labels
