import sys
sys.path.insert(0, "src/server")
import numpy as np
from asymmetric_loss import (
    compute_asymmetric_weights,
    compute_asymmetric_weights_with_neutral,
    effective_cost_ratio,
)


def test_symmetric_weights():
    y = np.array([1, 1, 0, 0, 1, 0])
    w = compute_asymmetric_weights(y, false_breakout_penalty=1.0)
    assert np.all(w == 1.0)


def test_asymmetric_weights_default():
    y = np.array([1, 1, 0, 0, 1, -1, 0, 1])
    w = compute_asymmetric_weights(y, false_breakout_penalty=2.0)
    assert w[0] == 1.0  # WIN
    assert w[2] == 2.0  # LOSS
    assert w[5] == 2.0  # NEUTRAL (treated as non-WIN)
    assert w[7] == 1.0  # WIN


def test_asymmetric_weights_aggressive():
    y = np.array([1, 0, 0, 0, 1])
    w = compute_asymmetric_weights(y, false_breakout_penalty=3.0)
    assert w[0] == 1.0
    assert w[1] == 3.0
    assert w[2] == 3.0
    assert w[3] == 3.0


def test_invalid_penalty():
    y = np.array([1, 0])
    try:
        compute_asymmetric_weights(y, false_breakout_penalty=0.5)
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_with_neutral_handling():
    y = np.array([1, 1, 0, -1, -1, 0, 1, -1])
    w = compute_asymmetric_weights_with_neutral(
        y, false_breakout_penalty=2.0, neutral_weight=0.5
    )
    assert w[0] == 1.0   # WIN
    assert w[2] == 0.5   # NEUTRAL
    assert w[3] == 2.0   # LOSS
    assert w[5] == 0.5   # NEUTRAL
    assert w[7] == 2.0   # LOSS


def test_neutral_weight_validation():
    y = np.array([1, 0, -1])
    try:
        compute_asymmetric_weights_with_neutral(y, neutral_weight=1.5)
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_effective_cost_ratio():
    w = np.array([1.0, 1.0, 2.0, 2.0])
    assert effective_cost_ratio(w) == 2.0


def test_effective_cost_ratio_symmetric():
    w = np.array([1.0, 1.0, 1.0])
    assert effective_cost_ratio(w) == 1.0


def test_effective_cost_ratio_empty():
    w = np.array([])
    assert effective_cost_ratio(w) == 1.0


def test_pandas_series_input():
    import pandas as pd
    y = pd.Series([1, 0, 1, -1, 0])
    w = compute_asymmetric_weights(y, false_breakout_penalty=2.0)
    assert w[0] == 1.0
    assert w[1] == 2.0
    assert w[3] == 2.0


if __name__ == "__main__":
    test_symmetric_weights()
    test_asymmetric_weights_default()
    test_asymmetric_weights_aggressive()
    test_invalid_penalty()
    test_with_neutral_handling()
    test_neutral_weight_validation()
    test_effective_cost_ratio()
    test_effective_cost_ratio_symmetric()
    test_effective_cost_ratio_empty()
    test_pandas_series_input()
    print("All asymmetric loss tests passed")
