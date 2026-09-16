"""Asymmetric Loss for False Breakout Penalty.

In stock prediction, a false positive (predicting a win that becomes a loss) is more costly
than a false negative (missing a winner):
- False positive: capital is deployed and LOST
- False negative: capital is preserved (opportunity cost only)

This module computes sample weights that make the model penalize false positives more
heavily. The weight ratio is controlled by `false_breakout_penalty`:
  - 1.0 = symmetric (standard logloss)
  - 2.0 = false positives penalized 2x (recommended default)
  - 3.0 = aggressive penalty for high-conviction strategies
"""
import numpy as np
import pandas as pd
from typing import Optional, Union


def compute_asymmetric_weights(
    y: Union[pd.Series, np.ndarray],
    false_breakout_penalty: float = 2.0,
    positive_label: int = 1,
) -> np.ndarray:
    """Compute sample weights that penalize false positives more heavily.

    The scheme:
      - Positive samples (y == positive_label): weight = 1.0
      - Negative samples (y != positive_label): weight = false_breakout_penalty

    This makes the model more conservative: it requires stronger evidence to predict
    a WIN, reducing false breakouts at the cost of some missed winners.

    Args:
        y: Target labels (binary: 1=WIN, 0/−1=LOSS/NEUTRAL)
        false_breakout_penalty: Weight multiplier for negative samples (>= 1.0)
        positive_label: Value representing the positive class (default 1)

    Returns:
        Array of sample weights, same length as y

    Example:
        >>> y = np.array([1, 1, 0, 0, 1, -1, 0, 1])
        >>> w = compute_asymmetric_weights(y, false_breakout_penalty=2.0)
        >>> # WIN samples get weight 1.0, LOSS/NEUTRAL get weight 2.0
        >>> assert w[0] == 1.0  # WIN
        >>> assert w[2] == 2.0  # LOSS
        >>> assert w[5] == 2.0  # NEUTRAL (treated as non-WIN)
    """
    y_arr = np.asarray(y)
    if false_breakout_penalty < 1.0:
        raise ValueError(
            f"false_breakout_penalty must be >= 1.0, got {false_breakout_penalty}"
        )
    weights = np.where(y_arr == positive_label, 1.0, float(false_breakout_penalty))
    return weights


def compute_asymmetric_weights_with_neutral(
    y: Union[pd.Series, np.ndarray],
    false_breakout_penalty: float = 2.0,
    neutral_weight: float = 0.5,
    positive_label: int = 1,
    neutral_label: int = 0,
) -> np.ndarray:
    """Compute asymmetric weights with separate handling for neutral samples.

    For triple-barrier labels (1=WIN, 0=NEUTRAL, −1=LOSS):
      - WIN samples: weight = 1.0
      - LOSS samples: weight = false_breakout_penalty (highest)
      - NEUTRAL samples: weight = neutral_weight (lowest, since these are ambiguous)

    Args:
        y: Target labels (1=WIN, 0=NEUTRAL, −1=LOSS)
        false_breakout_penalty: Weight for LOSS samples (>= 1.0)
        neutral_weight: Weight for NEUTRAL samples (0.0 to 1.0)
        positive_label: Value for WIN (default 1)
        neutral_label: Value for NEUTRAL (default 0)

    Returns:
        Array of sample weights
    """
    y_arr = np.asarray(y)
    if false_breakout_penalty < 1.0:
        raise ValueError(
            f"false_breakout_penalty must be >= 1.0, got {false_breakout_penalty}"
        )
    if not (0.0 <= neutral_weight <= 1.0):
        raise ValueError(
            f"neutral_weight must be in [0.0, 1.0], got {neutral_weight}"
        )
    weights = np.full(len(y_arr), float(false_breakout_penalty))
    weights[y_arr == positive_label] = 1.0
    weights[y_arr == neutral_label] = float(neutral_weight)
    return weights


def effective_cost_ratio(weights: np.ndarray) -> float:
    """Compute the effective cost ratio from asymmetric weights.

    Returns the ratio of negative-sample weight to positive-sample weight,
    which represents how much more the model penalizes false positives.

    Args:
        weights: Sample weights array

    Returns:
        Ratio of max weight to min weight (1.0 = symmetric)
    """
    w = np.asarray(weights)
    if len(w) == 0:
        return 1.0
    min_w = w.min()
    max_w = w.max()
    if min_w <= 0:
        return float('inf')
    return max_w / min_w
