"""AF-20260912-04 negative control.

`max_drawdown` compounded every signal in a group sequentially via
`(1 + r/100).cumprod()`. Live 2026-09-12 the h=15 group is 93,278 rows with a mean clipped
return of +2.216%, so the product is inf, the non-finite guard wrote NULL, and the metric was
never produced for any large group -- structurally dead, not occasionally degraded.

Restore the cumprod form in compute_metrics() and test_large_group_still_produces_a_drawdown
fails (max_drawdown comes back None).
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from performance_tracker import PerformanceTracker  # noqa: E402


def _metrics(returns):
    r = pd.Series(returns, dtype=float)
    outcomes = pd.Series(np.where(r > 0, "WIN", "LOSS"), index=r.index)
    return PerformanceTracker.compute_metrics(r, outcomes, horizon_days=15)


def test_large_group_computes_a_drawdown_without_overflowing():
    """The production shape: tens of thousands of rows with a positive mean return.

    `is not None` is NOT a sufficient assertion here, and finding that out is the reason
    this test looks the way it does. Under the old cumprod the series overflowed to inf
    partway, `(cum - peak) / peak` became inf/inf = NaN from that point on, and
    `Series.min()` SKIPS NaN -- so the metric returned a plausible, finite, correctly-signed
    drawdown computed from only the rows before the overflow. A wrong number, not a NULL.
    The overflow warning itself is therefore the only honest signal.
    """
    import warnings

    rng = np.random.default_rng(0)
    returns = rng.normal(2.2, 8.0, 93_278)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        m = _metrics(returns)
    overflows = [w for w in caught if issubclass(w.category, RuntimeWarning)
                 and "overflow" in str(w.message)]
    assert not overflows, (
        f"cumulative return overflowed ({len(overflows)} warning(s)); every row after the "
        f"overflow point is silently dropped from the drawdown by Series.min()'s NaN-skipping"
    )
    assert m["max_drawdown_pct"] is not None and np.isfinite(m["max_drawdown_pct"])
    # A drawdown is a percentage loss from a running peak: bounded to (-100, 0].
    assert -100.0 < m["max_drawdown_pct"] <= 0.0


def test_matches_the_direct_computation_on_a_small_group():
    """Log space must be algebraically identical where the direct form is still safe."""
    returns = [5.0, -3.0, 2.0, -10.0, 7.0, -1.5]
    m = _metrics(returns)
    clipped = pd.Series(returns).clip(-95, 95)
    cum = (1 + clipped / 100).cumprod()
    expected = float(((cum - cum.cummax()) / cum.cummax() * 100).min())
    assert m["max_drawdown_pct"] == __import__("pytest").approx(expected, abs=1e-9)


def test_a_monotonically_rising_group_has_zero_drawdown():
    m = _metrics([1.0, 2.0, 3.0, 4.0])
    assert m["max_drawdown_pct"] == __import__("pytest").approx(0.0, abs=1e-12)
