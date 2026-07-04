import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import working_capital_fetcher as wcf


def _balance_row(year_ending, inventories, receivables, payables):
    return {
        "yearEnding": year_ending,
        "inventories": inventories,
        "tradeReceivables": receivables,
        "tradePayables": payables,
    }


def _quarterly_row(year_ending, total_income, total_expenses):
    return {"yearEnding": year_ending, "totalIncome": total_income, "totalExpenses": total_expenses}


class TestComputeCcc:
    def test_single_fiscal_year_full_data(self):
        balance = [_balance_row("2026-03-31", inventories=10000.0, receivables=12000.0, payables=3500.0)]
        quarterly = [
            _quarterly_row("2026-03-31", 10000.0, 7000.0),
            _quarterly_row("2025-12-31", 9500.0, 6800.0),
            _quarterly_row("2025-09-30", 9000.0, 6500.0),
            _quarterly_row("2025-06-30", 8500.0, 6200.0),
        ]
        result = wcf.compute_ccc(balance, quarterly)

        assert len(result) == 1
        row = result[0]
        assert row["fiscal_year"] == "2026-03-31"
        revenue_fy = 10000.0 + 9500.0 + 9000.0 + 8500.0
        cogs_fy = 7000.0 + 6800.0 + 6500.0 + 6200.0
        assert row["revenue_fy"] == revenue_fy
        assert row["cogs_proxy_fy"] == cogs_fy
        assert row["receivables_days"] == round(12000.0 / revenue_fy * 365, 2)
        assert row["inventory_days"] == round(10000.0 / cogs_fy * 365, 2)
        assert row["payables_days"] == round(3500.0 / cogs_fy * 365, 2)
        assert row["ccc"] == round(row["receivables_days"] + row["inventory_days"] - row["payables_days"], 2)

    def test_skips_fiscal_year_with_fewer_than_4_matching_quarters(self):
        balance = [_balance_row("2026-03-31", 10000.0, 12000.0, 3500.0)]
        quarterly = [
            _quarterly_row("2026-03-31", 10000.0, 7000.0),
            _quarterly_row("2025-12-31", 9500.0, 6800.0),
        ]
        result = wcf.compute_ccc(balance, quarterly)
        assert result == []

    def test_skips_fiscal_year_with_zero_revenue(self):
        balance = [_balance_row("2026-03-31", 10000.0, 12000.0, 3500.0)]
        quarterly = [_quarterly_row("2026-03-31", 0.0, 0.0)] * 4
        result = wcf.compute_ccc(balance, quarterly)
        assert result == []

    def test_multiple_fiscal_years_each_computed_independently(self):
        balance = [
            _balance_row("2026-03-31", 10000.0, 12000.0, 3500.0),
            _balance_row("2025-03-31", 8000.0, 10000.0, 3000.0),
        ]
        quarterly = (
            [_quarterly_row("2026-03-31", 10000.0, 7000.0)] * 4 +
            [_quarterly_row("2025-03-31", 8000.0, 6000.0)] * 4
        )
        result = wcf.compute_ccc(balance, quarterly)
        assert len(result) == 2
        assert {r["fiscal_year"] for r in result} == {"2026-03-31", "2025-03-31"}

    def test_empty_inputs_return_empty_list(self):
        assert wcf.compute_ccc([], []) == []
        assert wcf.compute_ccc(None, None) == []
