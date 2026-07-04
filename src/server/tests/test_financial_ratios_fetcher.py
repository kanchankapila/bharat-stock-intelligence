import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import financial_ratios_fetcher as frf


def _cashflow_row(cfo, cfi):
    return {"netCashFlowFromOperatingActivities": cfo, "netCashUsedInInvestingActivities": cfi}


def _ratio_row(interest_coverage):
    return {"interestCoverage": interest_coverage}


class TestComputeRatios:
    def test_fcf_yield_uses_cfi_as_capex_proxy(self):
        cashflow = [_cashflow_row(cfo=1500.0, cfi=-400.0)]
        ratio = [_ratio_row(interest_coverage=12.5)]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=50000.0)

        # fcf_approx = cfo + cfi = 1500 + (-400) = 1100 (CFI is negative for capex-heavy firms)
        assert result["fcf_ttm_approx"] == 1100.0
        assert result["fcf_yield_approx"] == round(1100.0 / 50000.0 * 100, 4)
        assert result["interest_coverage"] == 12.5

    def test_interest_coverage_read_directly_not_derived(self):
        ratio = [_ratio_row(interest_coverage=1280.61)]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["interest_coverage"] == 1280.61
        assert result["fcf_yield_approx"] is None

    def test_missing_market_cap_yields_no_fcf_yield_but_keeps_fcf_amount(self):
        cashflow = [_cashflow_row(cfo=1000.0, cfi=-200.0)]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["fcf_ttm_approx"] == 800.0
        assert result["fcf_yield_approx"] is None

    def test_missing_cashflow_returns_all_none_for_fcf_fields(self):
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=None, market_cap=50000.0)
        assert result["fcf_ttm_approx"] is None
        assert result["fcf_yield_approx"] is None
        assert result["interest_coverage"] is None

    def test_debt_coverage_risk_flag_below_threshold(self):
        ratio = [_ratio_row(interest_coverage=1.2)]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["debt_coverage_risk"] == 1

    def test_debt_coverage_risk_flag_above_threshold(self):
        ratio = [_ratio_row(interest_coverage=5.0)]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["debt_coverage_risk"] == 0

    def test_fcf_positive_flag(self):
        cashflow = [_cashflow_row(cfo=1000.0, cfi=-1500.0)]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["fcf_ttm_approx"] == -500.0
        assert result["fcf_positive"] == 0

    def test_empty_ratio_list_element_missing_key_is_none(self):
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=[{}], market_cap=None)
        assert result["interest_coverage"] is None
