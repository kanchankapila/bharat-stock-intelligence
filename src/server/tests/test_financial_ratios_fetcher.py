import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import financial_ratios_fetcher as frf
import et_stats_client
from datetime import date, timedelta


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

    def test_year_ending_surfaced_for_point_in_time_stamp(self):
        cashflow = [{**_cashflow_row(1000.0, -200.0), "yearEnding": "2025-03-31"}]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["year_ending"] == "2025-03-31"

    def test_ratio_harvest_levels_and_roce_trend(self):
        # Two years of ratios (most-recent-first) → ROCE trend = latest - prior.
        ratio = [
            {"roce": 18.5, "quickRatio": 1.4, "evPerEBITDA": 12.0, "assetTurnover": 0.9},
            {"roce": 15.0},
        ]
        cashflow = [{**_cashflow_row(1000.0, -200.0), "cfoGrowth": 22.3}]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=None)
        assert result["roce"] == 18.5
        assert result["roce_trend"] == 3.5
        assert result["quick_ratio"] == 1.4
        assert result["ev_ebitda"] == 12.0
        assert result["asset_turnover"] == 0.9
        assert result["cfo_growth"] == 22.3

    def test_ratio_harvest_single_year_has_no_trend(self):
        ratio = [{"roce": 18.5}]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["roce"] == 18.5
        assert result["roce_trend"] is None


class TestAsOfFloor:
    def test_floor_is_year_ending_plus_publication_lag(self):
        floor = et_stats_client.as_of_floor("2025-03-31")
        expected = (date(2025, 3, 31) + timedelta(days=et_stats_client.PUBLICATION_LAG_DAYS)).isoformat()
        assert floor == expected

    def test_floor_never_earlier_than_year_ending(self):
        # The whole point: the stamp floor must be AFTER the fiscal year-end, never before,
        # so a freshly-reported figure can't back-fill onto rows that predate publication.
        assert et_stats_client.as_of_floor("2024-03-31") > "2024-03-31"

    def test_unknown_year_ending_falls_back_to_today(self):
        assert et_stats_client.as_of_floor(None) == date.today().isoformat()
        assert et_stats_client.as_of_floor("garbage") == date.today().isoformat()
