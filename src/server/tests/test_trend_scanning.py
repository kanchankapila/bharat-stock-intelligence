import sys
sys.path.insert(0, "src/server")
import numpy as np
from trend_scanning import trend_scanning_label, trend_scanning_labels_batch


def test_uptrend_detected():
    prices = np.array([100, 101, 102, 103, 104, 105])
    label = trend_scanning_label(prices, min_trend_days=3, max_hold_days=10, max_drawdown_pct=0.10)
    assert label == 1


def test_downtrend_detected():
    prices = np.array([100, 99, 98, 97, 96, 95])
    label = trend_scanning_label(prices, min_trend_days=3, max_hold_days=10, max_drawdown_pct=0.10)
    assert label == -1


def test_no_trend_choppy():
    prices = np.array([100, 101, 100, 101, 100, 101])
    label = trend_scanning_label(prices, min_trend_days=3, max_hold_days=10, max_drawdown_pct=0.10)
    assert label == 0


def test_uptrend_with_drawdown_breach():
    prices = np.array([100, 101, 102, 90, 103, 104])
    label = trend_scanning_label(prices, min_trend_days=3, max_hold_days=10, max_drawdown_pct=0.05)
    assert label == 0


def test_short_array():
    prices = np.array([100, 101])
    label = trend_scanning_label(prices, min_trend_days=3, max_hold_days=10, max_drawdown_pct=0.10)
    assert label == 0


def test_batch_labels():
    ohlcv = [{"close": 100}, {"close": 101}, {"close": 102}, {"close": 103}, {"close": 104}]
    labels = trend_scanning_labels_batch(ohlcv, min_trend_days=3, max_hold_days=10, max_drawdown_pct=0.10)
    assert len(labels) == 5
    assert labels[0] == 1


if __name__ == "__main__":
    test_uptrend_detected()
    test_downtrend_detected()
    test_no_trend_choppy()
    test_uptrend_with_drawdown_breach()
    test_short_array()
    test_batch_labels()
    print("All trend scanning tests passed")
