"""
Regression tests for the 2026-10-11 quant audit of institutional_quant_engine.compute_momentum_features.

Two defects were fixed in that one function, both of which silently made the WORST names in
the universe look like the best:

1. `np.std(rets)` used the population divisor (ddof=0) on a sample, biasing annualised vol
   low and Sharpe high -- and disagreeing with quantScoringWorker.ts, which computes the same
   `annualized_vol` column from the same prices.
2. Max drawdown was written to `max_drawdown_1y` as a NEGATIVE number while
   quantScoringWorker.ts writes the same column as a POSITIVE magnitude. Every consumer of
   that column (`max_drawdown_1y <= ?`, `maxDD / 20` risk normalisation, `good="low"`,
   ddRanks with higherIsBetter=false) reads positive, so the negative rows sorted to the top
   as the LEAST risky names.
"""
import math

import numpy as np
import pandas as pd
import pytest

from institutional_quant_engine import InstitutionalQuantEngine


def _frame(closes, symbol="TEST"):
    dates = pd.date_range("2025-01-01", periods=len(closes), freq="B")
    return pd.DataFrame({
        "symbol": symbol,
        "date": dates,
        "close": [float(c) for c in closes],
        "volume": [1_000_000] * len(closes),
    })


def _features(closes):
    engine = InstitutionalQuantEngine.__new__(InstitutionalQuantEngine)
    out = engine.compute_momentum_features(_frame(closes))
    assert len(out) == 1
    return out.iloc[0]


class TestAnnualizedVolIsSampleStd:
    """ddof=1 is the correct estimator for a realised-vol sample and matches the TypeScript
    producer of the same column."""

    def test_matches_manual_sample_std_computation(self):
        closes = [100.0]
        for i in range(1, 260):
            # deterministic pseudo-walk, no RNG seed dependency
            closes.append(closes[-1] * (1.0 + ((i * 7919) % 211 - 100) / 2000.0))
        row = _features(closes)

        rets = np.diff(np.log(np.array(closes[-253:], dtype=float)))
        expected = float(np.std(rets, ddof=1) * math.sqrt(252) * 100)
        assert row["annualized_vol"] == pytest.approx(expected)

    def test_population_ddof_would_understate_vol(self):
        closes = [100.0 * (1.0 + ((i * 7919) % 211 - 100) / 2000.0) for i in range(253)]
        row = _features(closes)
        rets = np.diff(np.log(np.array(closes[-253:], dtype=float)))
        population = float(np.std(rets, ddof=0) * math.sqrt(252) * 100)
        # The fix must not reproduce the old (biased) number.
        assert row["annualized_vol"] > population


class TestMaxDrawdownSignConvention:
    """`max_drawdown_1y` is a positive magnitude everywhere it is consumed."""

    def test_drawdown_is_positive_for_a_falling_stock(self):
        closes = [100.0] * 10 + [90.0] * 250        # a clean 10% peak-to-trough
        row = _features(closes)
        assert row["max_drawdown_1y"] == pytest.approx(10.0)

    def test_drawdown_is_zero_for_a_monotonically_rising_stock(self):
        closes = [100.0 + i * 0.1 for i in range(260)]
        row = _features(closes)
        assert row["max_drawdown_1y"] == pytest.approx(0.0)

    def test_drawdown_is_never_negative(self):
        for closes in ([100.0] * 260, [100.0 - i for i in range(260)],
                       [100.0 + (i % 3) for i in range(260)]):
            assert _features(closes)["max_drawdown_1y"] >= 0

    def test_uses_the_running_peak_not_the_window_open(self):
        # Rises to 200, then falls to 100: a -50% drawdown, not the -0% a
        # first-bar-as-peak implementation would report.
        closes = [100.0] * 5 + [200.0] * 5 + [100.0] * 250
        row = _features(closes)
        assert row["max_drawdown_1y"] == pytest.approx(50.0)


class TestSharpeUsesSharedRiskFreeRate:
    """The rate must come from risk_free_rate.py, not a local constant, or Sharpe values in
    one column stop being comparable row-to-row."""

    def test_uses_risk_free_rate_module_value(self, monkeypatch):
        from risk_free_rate import DEFAULT_RISK_FREE_ANNUAL
        closes = [100.0 * (1.0 + ((i * 7919) % 211 - 100) / 2000.0) for i in range(253)]
        row = _features(closes)
        expected = ((float(np.mean(np.diff(np.log(np.array(closes[-253:], dtype=float)))))
                     * 252 * 100) - DEFAULT_RISK_FREE_ANNUAL * 100) / row["annualized_vol"]
        assert row["sharpe_ratio"] == pytest.approx(expected)

    def test_changing_the_shared_rate_moves_sharpe(self, monkeypatch):
        closes = [100.0 * (1.0 + ((i * 7919) % 211 - 100) / 2000.0) for i in range(253)]
        before = _features(closes)["sharpe_ratio"]
        import institutional_quant_engine as iqe
        monkeypatch.setattr(iqe, "get_risk_free_annual", lambda: 0.12)
        after = _features(closes)["sharpe_ratio"]
        # A higher risk-free rate must LOWER Sharpe, not raise it.
        assert after < before
