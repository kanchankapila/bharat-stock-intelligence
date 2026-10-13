import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import financial_ratios_fetcher as frf
import et_stats_client
import pytest
from datetime import date, timedelta
from unittest.mock import MagicMock


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

    def test_universal_solvency_harvest(self):
        # interestCoveragePostTax / longTermDebtEquity — live-verified field names against
        # Reliance Industries (cType=NonBank): interestCoveragePostTax=7.35, longTermDebtEquity=0.33.
        ratio = [{"interestCoveragePostTax": 7.35, "longTermDebtEquity": 0.33}]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["interest_coverage_post_tax"] == 7.35
        assert result["lt_de_ratio"] == 0.33

    def test_banking_ratios_populated_for_bank_ctype(self):
        # Field names + live values verified against HDFCBANK (cType=Bank) on 2026-07-23.
        ratio = [{
            "cType": "Bank",
            "nim": 2.94, "costToIncome": 37.99,
            "interestIncomeByEarningAssets": 7.04, "nonInterestIncomeByEarningAssets": 1.43,
            "operatingProfitByEarningAssets": 0.27, "operatingExpensesByEarningAssets": 1.66,
            "interestExpensesByEarningAssets": 4.09,
            "capitalAdequacyRatios": 19.71, "keyPerformanceTier1": 17.73, "keyPerformanceTier2": 1.98,
            "grossNPAPercentage": 1.15, "netNPAPercentage": 1.15, "netNPAToAdvancesPercentage": 0.38,
            "numberOfBranches": 9689.0,
            "interestIncomePerEmployee": 0.15, "npPerEmployee": 0.04, "businessPerEmployee": 2.86,
            "interestIncomePerBranch": 3.17, "npPerBranches": 0.77,
        }]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["nim"] == 2.94
        assert result["cost_to_income"] == 37.99
        assert result["capital_adequacy"] == 19.71
        assert result["tier1_capital"] == 17.73
        assert result["tier2_capital"] == 1.98
        assert result["gross_npa_pct"] == 1.15
        assert result["net_npa_pct"] == 1.15
        assert result["net_npa_to_advances"] == 0.38
        assert result["num_branches"] == 9689.0
        assert result["business_per_employee"] == 2.86
        assert result["np_per_branch"] == 0.77

    def test_banking_ratios_none_for_nonbank_ctype(self):
        # Non-bank stocks get cType=NonBank and every banking-only field is None on the raw
        # payload — must surface as None here, not 0 or a crash (0 would read as "zero NPAs",
        # a false-positive quality signal).
        ratio = [{"cType": "NonBank", "nim": None, "capitalAdequacyRatios": None, "grossNPAPercentage": None}]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["nim"] is None
        assert result["capital_adequacy"] is None
        assert result["gross_npa_pct"] is None

    def test_cfi_cff_growth_harvest(self):
        cashflow = [{**_cashflow_row(1000.0, -200.0), "cfiGrowth": -12.4, "cffGrowth": 5.1}]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["cfi_growth"] == -12.4
        assert result["cff_growth"] == 5.1

    def test_cfi_cff_growth_na_string_is_none_not_crash(self):
        # ET_Stats returns the literal string "NA" for an unavailable growth figure.
        cashflow = [{**_cashflow_row(1000.0, -200.0), "cfiGrowth": "NA", "cffGrowth": "NA"}]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["cfi_growth"] is None
        assert result["cff_growth"] is None

    def test_cfo_cagr_computed_from_6_period_cashflow_list(self):
        # Most-recent-first: index 0 = latest, index 3 = 3Y ago, index 5 = 5Y ago.
        # Clean 10%/year geometric series (index_k = 1000 * 1.1^(5-k)) so both CAGRs
        # resolve to an exact 10.0% instead of an eyeballed decimal.
        cashflow = [
            {"netCashFlowFromOperatingActivities": 1610.51},  # latest (1000*1.1^5)
            {"netCashFlowFromOperatingActivities": 1464.1},
            {"netCashFlowFromOperatingActivities": 1331.0},
            {"netCashFlowFromOperatingActivities": 1210.0},   # 3Y ago (1000*1.1^2)
            {"netCashFlowFromOperatingActivities": 1100.0},
            {"netCashFlowFromOperatingActivities": 1000.0},   # 5Y ago
        ]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["cfo_cagr_3y"] == 10.0
        assert result["cfo_cagr_5y"] == 10.0

    def test_cagr_none_when_fewer_than_required_periods(self):
        # Only 4 periods available (indices 0-3) — index 5 doesn't exist, so 5Y CAGR must be
        # None rather than IndexError.
        cashflow = [{"netCashFlowFromOperatingActivities": v} for v in [1000, 900, 800, 700]]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["cfo_cagr_5y"] is None
        assert result["cfo_cagr_3y"] is not None  # index 3 exists

    def test_cagr_none_when_cfi_negative_both_periods(self):
        # CFI (net cash USED in investing) is routinely negative — CAGR of a negative series
        # is undefined (fractional power of a negative base), must be None, not a complex number
        # or a crash.
        cashflow = [{"netCashUsedInInvestingActivities": v} for v in [-500, -450, -400, -300]]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["cfi_cagr_3y"] is None

class TestFetchFailureHonesty:

    def test_process_stock_rejects_an_empty_upstream_payload_before_writing(self, monkeypatch):
        monkeypatch.setattr(frf, "fetch_et_stats", lambda *args, **kwargs: None)
        upsert = MagicMock()
        monkeypatch.setattr(frf, "upsert_quality", upsert)
        monkeypatch.setattr(frf, "upsert_cashflow_history", MagicMock())
        monkeypatch.setattr(frf, "update_technical_signals", MagicMock())
        monkeypatch.setattr(frf, "get_market_cap", lambda *args: 1000.0)

        with pytest.raises(RuntimeError, match="returned no CashFlow or Ratio data"):
            frf.process_stock("TEST", "123", "2026-10-09", MagicMock(), MagicMock())

        upsert.assert_not_called()

class TestTtmFcfFromQuarters:

    """The 2026-10-11 quant-audit fix: FCF = CFO − CapEx, summed over four REAL quarters,
    replacing the CFO+CFI proxy as the primary basis.

    Regression case from the live universe (BHARTIARTL, 2026-06-30): CFO 336.3bn and
    capex −142.1bn give FCF 194.2bn. The old CFO+CFI proxy answered a different
    question entirely, because CFI also nets asset sales, acquisitions, subsidiary
    disposals and securities-book movement.
    """

    @staticmethod
    def _q(period_end, ocf, capex):
        return {"period_end": period_end, "ocf": ocf, "capex": capex}

    def test_sums_four_quarters_of_cfo_minus_capex(self):
        rows = [
            self._q("2026-06-30", 336_346_000_000, -142_130_000_000),
            self._q("2026-03-31", 286_344_000_000, -124_392_000_000),
            self._q("2025-12-31", 250_000_000_000, -100_000_000_000),
            self._q("2025-09-30", 240_000_000_000, -98_000_000_000),
            self._q("2025-06-30", 230_000_000_000, -95_000_000_000),  # excluded: 5th
        ]
        fcf, latest = frf._ttm_fcf_from_quarters(rows)
        assert latest == "2026-06-30"
        assert fcf == round((336_346_000_000 - 142_130_000_000)
                            + (286_344_000_000 - 124_392_000_000)
                            + (250_000_000_000 - 100_000_000_000)
                            + (240_000_000_000 - 98_000_000_000), 2)

    def test_newest_first_input_is_sorted_not_trusted(self):
        newest_first = [
            self._q("2026-06-30", 100, -10),
            self._q("2026-03-31", 100, -10),
            self._q("2025-12-31", 100, -10),
            self._q("2025-09-30", 100, -10),
        ]
        assert frf._ttm_fcf_from_quarters(newest_first)[0] == 360.0
        assert frf._ttm_fcf_from_quarters(list(reversed(newest_first)))[0] == 360.0

    def test_none_when_fewer_than_four_quarters(self):
        rows = [self._q("2026-06-30", 100, -10), self._q("2026-03-31", 100, -10)]
        assert frf._ttm_fcf_from_quarters(rows) == (None, None)

    def test_none_when_a_quarter_is_missing_capex(self):
        """A quarter with no capex line cannot contribute to an FCF sum — reporting a
        3-quarter sum as TTM would understate a full year's capex."""
        rows = [
            self._q("2026-06-30", 100, -10),
            self._q("2026-03-31", 100, None),
            self._q("2025-12-31", 100, -10),
            self._q("2025-09-30", 100, -10),
        ]
        assert frf._ttm_fcf_from_quarters(rows) == (None, None)

    def test_none_when_window_has_a_gap(self):
        rows = [
            self._q("2026-06-30", 100, -10),
            self._q("2025-12-31", 100, -10),   # 6-month hole inside the window
            self._q("2025-09-30", 100, -10),
            self._q("2025-06-30", 100, -10),
        ]
        assert frf._ttm_fcf_from_quarters(rows) == (None, None)

    def test_as_of_excludes_a_quarter_published_later(self):
        rows = [
            self._q("2026-06-30", 100, -10),   # after the annual FY26 results
            self._q("2026-03-31", 100, -10),
            self._q("2025-12-31", 100, -10),
            self._q("2025-09-30", 100, -10),
            self._q("2025-06-30", 100, -10),
        ]
        fcf, latest = frf._ttm_fcf_from_quarters(rows, as_of="2026-03-31")
        assert latest == "2026-03-31"
        assert fcf == 360.0

    def test_as_of_can_disqualify_the_window_entirely(self):
        rows = [self._q("2026-06-30", 100, -10), self._q("2026-03-31", 100, -10)]
        assert frf._ttm_fcf_from_quarters(rows, as_of="2025-12-31") == (None, None)

    def test_none_and_empty_inputs(self):
        assert frf._ttm_fcf_from_quarters(None) == (None, None)
        assert frf._ttm_fcf_from_quarters([]) == (None, None)
        assert frf._ttm_fcf_from_quarters([None, 42]) == (None, None)

    def test_basis_labels_distinct(self):
        assert frf.FCF_BASIS_CAPEX != frf.FCF_BASIS_PROXY

    """The 2026-10-11 quant-audit fix: FCF = CFO - CapEx, summed over four REAL quarters,
    replacing the CFO+CFI proxy as the primary basis.

    Regression case from the live universe (BHARTIARTL, 2026-06-30): CFO 336.3bn and
    capex -142.1bn give FCF 194.2bn. The old CFO+CFI proxy answered a different question
    entirely, because CFI also nets asset sales, acquisitions, subsidiary disposals and
    securities-book movement.
    """

    """The 2026-10-11 quant-audit fix: FCF = CFO − CapEx, summed over four REAL quarters,
    replacing the CFO+CFI proxy as the primary basis.

    Regression case from the live universe (BHARTIARTL, 2026-06-30): CFO 336.3bn and
    capex −142.1bn give FCF 194.2bn. The old CFO+CFI proxy answered a different
    question entirely, because CFI also nets asset sales, acquisitions, subsidiary
    disposals and securities-book movement.
    """

    """The 2026-10-11 quant-audit fix: FCF = CFO − CapEx, summed over four REAL quarters,
    replacing the CFO+CFI proxy as the primary basis.

    Regression case from the live universe (BHARTIARTL, 2026-06-30): CFO 336.3bn and
    capex −142.1bn give FCF 194.2bn. The old CFO+CFI proxy answered a different
    question entirely, because CFI also nets asset sales, acquisitions, subsidiary
    disposals and securities-book movement.
    """

    """The 2026-10-11 quant-audit fix: FCF = CFO - CapEx summed over four REAL quarters,
    replacing the CFO+CFI proxy as the primary basis.

    Regression case from the live universe (BHARTIARTL, 2026-06-30): CFO 336.3bn and
    capex -142.1bn give FCF 194.2bn. The old CFO+CFI proxy answered a different
    question entirely, because CFI also nets asset sales, acquisitions, subsidiary
    disposals and securities-book movement.
    """

    def test_basis_labels_are_distinct(self):
        assert frf.FCF_BASIS_CAPEX != frf.FCF_BASIS_PROXY

    """The 2026-10-11 quant-audit fix: FCF = CFO − CapEx, summed over four REAL quarters,
    replacing the CFO+CFI proxy as the primary basis.

    Regression case from the live universe (BHARTIARTL, 2026-06-30): CFO 336.3bn and
    capex −142.1bn give FCF 194.2bn. The old CFO+CFI proxy answered a different
    question entirely, because CFI also nets asset sales, acquisitions, subsidiary
    disposals and securities-book movement.
    """

class TestProcessStockPrefersRealCapexFcf:

    """process_stock must overwrite the CFO+CFI proxy with the real TTM capex FCF when
    finstack history exists, and must LABEL the row so a consumer can tell the two bases
    apart instead of silently mixing them in one column."""

    @staticmethod
    def _cashflow():
        return [{"yearEnding": "2026-03-31",
                 "netCashFlowFromOperatingActivities": 1500.0,
                 "netCashUsedInInvestingActivities": -400.0}]

    def _run(self, monkeypatch, fcf_ttm, latest_period, market_cap=50000.0):
        captured = {}
        monkeypatch.setattr(frf, "fetch_et_stats",
                            lambda cid, family, sess, **kw: self._cashflow() if family == "CashFlow"
                            else [{"interestCoverage": 12.5}])
        monkeypatch.setattr(frf, "get_market_cap", lambda *a: market_cap)
        monkeypatch.setattr(frf, "finstack_ttm_fcf",
                            lambda con, symbol, as_of=None: (fcf_ttm, latest_period))
        monkeypatch.setattr(frf, "upsert_quality",
                            lambda sym, today, feats, con: captured.setdefault("feats", feats))
        monkeypatch.setattr(frf, "upsert_cashflow_history", MagicMock())
        monkeypatch.setattr(frf, "update_technical_signals", MagicMock())
        frf.process_stock("TEST", "123", "2026-10-11", MagicMock(), MagicMock())
        return captured["feats"]

    def test_real_capex_fcf_replaces_the_proxy(self, monkeypatch):
        feats = self._run(monkeypatch, fcf_ttm=1942.16, latest_period="2026-06-30")
        # proxy would have said 1100.0; the real CFO−CapEx number wins
        assert feats["fcf_ttm_approx"] == 1942.16
        assert feats["fcf_positive"] == 1
        assert feats["fcf_yield_approx"] == round(1942.16 / 50000.0 * 100, 4)
        assert feats["fcf_basis"] == frf.FCF_BASIS_CAPEX
        assert feats["fcf_ttm_as_of"] == "2026-06-30"

    def test_real_negative_capex_fcf_flips_fcf_positive(self, monkeypatch):
        feats = self._run(monkeypatch, fcf_ttm=-200.0, latest_period="2026-06-30")
        assert feats["fcf_positive"] == 0
        assert feats["fcf_ttm_approx"] == -200.0

    def test_proxy_survives_but_is_labelled_when_no_vendor_history(self, monkeypatch):
        # CashFlow is still fetched (ET is reachable); only the vendor capex history is absent.
        feats = self._run(monkeypatch, fcf_ttm=None, latest_period=None)
        assert feats["fcf_ttm_approx"] == 1100.0            # unchanged CFO+CFI
        assert feats["fcf_basis"] == frf.FCF_BASIS_PROXY     # but now honestly labelled
        assert feats["fcf_ttm_as_of"] is None

    def test_et_outage_raises_before_any_write(self, monkeypatch):
        """No ET payload at all is still a hard failure — the FCF fallback must not become a
        way to write rows built from nothing."""
        monkeypatch.setattr(frf, "fetch_et_stats", lambda cid, family, sess, **kw: None)
        with pytest.raises(RuntimeError, match="no CashFlow or Ratio data"):
            frf.process_stock("TEST", "123", "2026-10-11", MagicMock(), MagicMock())

    """process_stock must overwrite the CFO+CFI proxy with the real TTM capex FCF when
    finstack history exists, and must LABEL the row so a consumer can tell the two bases
    apart instead of silently mixing them in one column."""

    def test_cashflow_without_investing_line_leaves_basis_null(self, monkeypatch):
        """No CFI line means no proxy, and no vendor history means no real FCF either — the
        row must not invent a basis label."""
        captured = {}
        cf = [{"yearEnding": "2026-03-31",
               "netCashFlowFromOperatingActivities": 1500.0,
               "netCashUsedInInvestingActivities": None}]
        monkeypatch.setattr(frf, "fetch_et_stats",
                            lambda cid, family, sess, **kw: cf if family == "CashFlow"
                            else [{"interestCoverage": 12.5}])
        monkeypatch.setattr(frf, "get_market_cap", lambda *a: 50000.0)
        monkeypatch.setattr(frf, "finstack_ttm_fcf", lambda con, symbol, as_of=None: (None, None))
        monkeypatch.setattr(frf, "upsert_quality",
                            lambda sym, today, feats, con: captured.setdefault("feats", feats))
        monkeypatch.setattr(frf, "upsert_cashflow_history", MagicMock())
        monkeypatch.setattr(frf, "update_technical_signals", MagicMock())

        frf.process_stock("TEST", "123", "2026-10-11", MagicMock(), MagicMock())
        assert captured["feats"]["fcf_ttm_approx"] is None
        assert captured["feats"]["fcf_basis"] is None
        assert captured["feats"]["fcf_positive"] is None

class TestProcessStockFcfBasis:

    """process_stock must overwrite the CFO+CFI proxy with the real TTM capex FCF when
    finstack history exists, and must LABEL the row so a consumer can tell the two bases
    apart instead of silently mixing them in one column."""

    @staticmethod
    def _cashflow():
        return [{"yearEnding": "2026-03-31",
                 "netCashFlowFromOperatingActivities": 1500.0,
                 "netCashUsedInInvestingActivities": -400.0}]

    def _run(self, monkeypatch, fcf_ttm, latest_period, market_cap=50000.0):
        captured = {}

        def fake_fetch(cid, family, sess, **kw):
            if family == "CashFlow":
                return self._cashflow()
            return [{"interestCoverage": 12.5}]

        monkeypatch.setattr(frf, "fetch_et_stats", fake_fetch)
        monkeypatch.setattr(frf, "get_market_cap", lambda *a: market_cap)
        monkeypatch.setattr(frf, "finstack_ttm_fcf", lambda con, symbol, as_of=None: (fcf_ttm, latest_period))
        monkeypatch.setattr(frf, "upsert_quality", lambda sym, today, feats, con: captured.setdefault("feats", feats))
        monkeypatch.setattr(frf, "upsert_cashflow_history", MagicMock())
        monkeypatch.setattr(frf, "update_technical_signals", MagicMock())

        frf.process_stock("TEST", "123", "2026-10-11", MagicMock(), MagicMock())
        return captured["feats"]

    def test_real_capex_fcf_replaces_the_proxy(self, monkeypatch):
        feats = self._run(monkeypatch, fcf_ttm=1942.16, latest_period="2026-06-30")
        # the CFO+CFI proxy would have said 1100.0; the real CFO-CapEx number wins
        assert feats["fcf_ttm_approx"] == 1942.16
        assert feats["fcf_positive"] == 1
        assert feats["fcf_yield_approx"] == round(1942.16 / 50000.0 * 100, 4)
        assert feats["fcf_basis"] == frf.FCF_BASIS_CAPEX
        assert feats["fcf_ttm_as_of"] == "2026-06-30"

    def test_real_negative_capex_fcf_flips_fcf_positive(self, monkeypatch):
        feats = self._run(monkeypatch, fcf_ttm=-200.0, latest_period="2026-06-30")
        assert feats["fcf_ttm_approx"] == -200.0
        assert feats["fcf_positive"] == 0

    def test_proxy_survives_but_is_labelled_when_no_vendor_history(self, monkeypatch):
        feats = self._run(monkeypatch, fcf_ttm=None, latest_period=None)
        assert feats["fcf_ttm_approx"] == 1100.0            # unchanged CFO+CFI
        assert feats["fcf_basis"] == frf.FCF_BASIS_PROXY     # but now honestly labelled
        assert feats["fcf_ttm_as_of"] is None

    def test_no_cfo_or_cfi_and_no_vendor_history_leaves_basis_null(self, monkeypatch):
        """A CashFlow payload that carries neither OCF nor CFI yields no proxy, and with no
        finstack history there is nothing to label -- basis stays NULL rather than claiming
        a number that was never computed."""
        captured = {}

        monkeypatch.setattr(frf, "fetch_et_stats",
                            lambda cid, family, sess, **kw:
                            [{"yearEnding": "2026-03-31"}] if family == "CashFlow"
                            else [{"interestCoverage": 12.5}])
        monkeypatch.setattr(frf, "get_market_cap", lambda *a: 50000.0)
        monkeypatch.setattr(frf, "finstack_ttm_fcf", lambda con, symbol, as_of=None: (None, None))
        monkeypatch.setattr(frf, "upsert_quality", lambda sym, today, feats, con: captured.setdefault("feats", feats))
        monkeypatch.setattr(frf, "upsert_cashflow_history", MagicMock())
        monkeypatch.setattr(frf, "update_technical_signals", MagicMock())

        frf.process_stock("TEST", "123", "2026-10-11", MagicMock(), MagicMock())
        feats = captured["feats"]
        assert feats["fcf_ttm_approx"] is None
        assert feats["fcf_positive"] is None
        assert feats["fcf_basis"] is None

    def test_absent_cashflow_payload_still_raises(self, monkeypatch):
        """Guard on the pre-existing contract: a missing CashFlow family is a fetch failure
        and must not be silently written as a NULL-FCF row."""
        monkeypatch.setattr(frf, "fetch_et_stats",
                            lambda cid, family, sess, **kw:
                            [{"interestCoverage": 12.5}] if family == "Ratio" else None)
        with pytest.raises(RuntimeError, match="no CashFlow data"):
            frf.process_stock("TEST", "123", "2026-10-11", MagicMock(), MagicMock())

class TestCagrHelper:

    def test_cagr_normal_case(self):
        # 1000 * 1.1^3 = 1331.0 exactly -> a clean 10.0% CAGR over 3 years.
        assert frf._cagr(latest=1331.0, base=1000.0, years=3) == 10.0

    def test_cagr_none_on_negative_base(self):
        assert frf._cagr(latest=100.0, base=-50.0, years=3) is None

    def test_cagr_none_on_negative_latest(self):
        assert frf._cagr(latest=-100.0, base=50.0, years=3) is None

    def test_cagr_none_on_zero_base(self):
        assert frf._cagr(latest=100.0, base=0.0, years=3) is None

    def test_cagr_none_on_missing_values(self):
        assert frf._cagr(latest=None, base=100.0, years=3) is None
        assert frf._cagr(latest=100.0, base=None, years=3) is None

    def test_cagr_none_on_zero_years(self):
        assert frf._cagr(latest=100.0, base=50.0, years=0) is None

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

class TestParseCashflowSeries:

    """Pins the 2026-09-01 full-series harvest: the last=6 CashFlow payload was already being
    fetched, but only period [0] survived. parse_cashflow_series keeps every period with a
    parseable yearEnding and at least one non-None cash-flow figure."""

    def test_keeps_all_periods_with_data(self):
        cashflow = [
            {"yearEnding": "2026-03-31", "netCashFlowFromOperatingActivities": 1500.0,
             "netCashUsedInInvestingActivities": -400.0,
             "netCashUsedFromFinancingActivities": -900.0},
            {"yearEnding": "2025-03-31", "netCashFlowFromOperatingActivities": 1200.0,
             "netCashUsedInInvestingActivities": -350.0,
             "netCashUsedFromFinancingActivities": -700.0},
        ]
        rows = frf.parse_cashflow_series(cashflow)
        assert [r["year_ending"] for r in rows] == ["2026-03-31", "2025-03-31"]
        assert rows[0] == {"year_ending": "2026-03-31", "cfo": 1500.0, "cfi": -400.0, "cff": -900.0}

    def test_keeps_period_with_only_one_figure(self):
        rows = frf.parse_cashflow_series([
            {"yearEnding": "2024-03-31", "netCashFlowFromOperatingActivities": 800.0},
        ])
        assert rows == [{"year_ending": "2024-03-31", "cfo": 800.0, "cfi": None, "cff": None}]

    def test_drops_all_null_periods(self):
        rows = frf.parse_cashflow_series([
            {"yearEnding": "2023-03-31", "netCashFlowFromOperatingActivities": None,
             "netCashUsedInInvestingActivities": None},
        ])
        assert rows == []

    def test_drops_missing_or_garbage_year_ending(self):
        rows = frf.parse_cashflow_series([
            {"netCashFlowFromOperatingActivities": 100.0},                     # no yearEnding
            {"yearEnding": "garbage", "netCashFlowFromOperatingActivities": 100.0},
            {"yearEnding": None, "netCashFlowFromOperatingActivities": 100.0},
        ])
        assert rows == []

    def test_none_and_non_dict_payloads(self):
        assert frf.parse_cashflow_series(None) == []
        assert frf.parse_cashflow_series([]) == []
        assert frf.parse_cashflow_series(["junk", 42]) == []

    def test_rounds_to_2dp_and_iso_normalizes(self):
        rows = frf.parse_cashflow_series([
            {"yearEnding": "2026-03-31T00:00:00", "netCashFlowFromOperatingActivities": 1234.56789},
        ])
        assert rows[0]["year_ending"] == "2026-03-31"
        assert rows[0]["cfo"] == 1234.57

class TestUpsertCashflowHistory:

    """DB idempotency: the weekly cadence must converge (refresh in place), not accumulate.
    Auto-skips without live Postgres, like every pg_conn test in this suite."""

    def test_upsert_is_idempotent_and_refreshes(self, pg_conn):
        frf.ensure_schema(pg_conn)
        pg_conn.execute("DELETE FROM et_cashflow_history")
        pg_conn.commit()

        rows = frf.parse_cashflow_series([
            {"yearEnding": "2026-03-31", "netCashFlowFromOperatingActivities": 1500.0,
             "netCashUsedInInvestingActivities": -400.0},
            {"yearEnding": "2025-03-31", "netCashFlowFromOperatingActivities": 1200.0,
             "netCashUsedInInvestingActivities": -350.0},
        ])
        frf.upsert_cashflow_history("BEL", rows, pg_conn)
        frf.upsert_cashflow_history("BEL", rows, pg_conn)  # second run: no duplicate rows

        cur = pg_conn.execute("SELECT year_ending, cfo, cfi FROM et_cashflow_history WHERE symbol = 'BEL' ORDER BY year_ending DESC")
        assert cur.fetchall() == [
            ("2026-03-31", 1500.0, -400.0),
            ("2025-03-31", 1200.0, -350.0),
        ]

        # restatement: same PK, new figures -> refreshed in place
        rows[0]["cfo"] = 1600.0
        frf.upsert_cashflow_history("BEL", rows, pg_conn)
        cur = pg_conn.execute("SELECT cfo FROM et_cashflow_history WHERE symbol = 'BEL' AND year_ending = '2026-03-31'")
        assert cur.fetchall() == [(1600.0,)]

    def test_empty_rows_is_a_noop(self, pg_conn):
        frf.upsert_cashflow_history("BEL", [], pg_conn)  # must not raise
