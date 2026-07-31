import os
import sys
from unittest.mock import MagicMock

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

    def test_excludes_adjacent_fiscal_year_quarter_mixed_into_the_same_call(self):
        """A genuine FY26 quarter set plus one out-of-window FY25 quarter in the
        same quarterly list must still compute correctly for FY26 — the extra
        row must not corrupt the 4-quarter average or leak into results."""
        balance = [_balance_row("2026-03-31", inventories=10000.0, receivables=12000.0, payables=3500.0)]
        quarterly = [
            _quarterly_row("2026-03-31", 10000.0, 7000.0),
            _quarterly_row("2025-12-31", 9500.0, 6800.0),
            _quarterly_row("2025-09-30", 9000.0, 6500.0),
            _quarterly_row("2025-06-30", 8500.0, 6200.0),
            _quarterly_row("2025-03-31", 8000.0, 5900.0),  # FY25 — must be excluded from FY26's CCC
        ]
        result = wcf.compute_ccc(balance, quarterly)

        assert len(result) == 1
        row = result[0]
        # Revenue/COGS must be computed from exactly the 4 genuine FY26 quarters,
        # NOT including the FY25 8000.0/5900.0 values.
        revenue_fy = 10000.0 + 9500.0 + 9000.0 + 8500.0
        cogs_fy = 7000.0 + 6800.0 + 6500.0 + 6200.0
        assert row["revenue_fy"] == revenue_fy
        assert row["cogs_proxy_fy"] == cogs_fy


class TestUpdateTechnicalSignalsAsOfFallback:
    """Regression for the 2026-07-30 audit finding: update_technical_signals() called
    as_of_floor() with no `fallback=` argument, so on an unparseable/missing year_ending
    it silently fell through to a bare date.today() inside as_of_floor() -- which matches
    zero technical_signals rows on the trendlyne-ratios-monthly run's non-trading-day
    schedule, making the whole UPDATE a silent no-op. financial_ratios_fetcher.py's sibling
    call already threads a trading-session-anchored `today` through as `fallback=`; this
    test asserts working_capital_fetcher.py now does the same."""

    def test_passes_today_as_fallback_to_as_of_floor(self, monkeypatch):
        captured = {}

        def fake_as_of_floor(year_ending, fallback=None):
            captured["year_ending"] = year_ending
            captured["fallback"] = fallback
            return "2026-01-01"

        monkeypatch.setattr(wcf, "as_of_floor", fake_as_of_floor)
        con = MagicMock()
        features = {
            "receivables_days_ttm": 40.0, "ccc_ttm": 30.0, "ccc_trend": 2.0,
            "wc_deteriorating": 0, "wc_improving": 0, "year_ending": None,
        }
        wcf.update_technical_signals("RELIANCE", features, con, today="2026-07-24")

        assert captured["fallback"] == "2026-07-24", (
            "update_technical_signals must pass its `today` param through to as_of_floor's "
            "fallback= -- omitting it silently degrades to as_of_floor's own bare date.today() "
            "default on the unparseable-year_ending path"
        )

    def test_process_stock_threads_today_into_update_technical_signals(self, monkeypatch):
        recorded = {}

        def fake_update_technical_signals(symbol, features, con, today=None):
            recorded["today"] = today

        def fake_fetch_et_stats(company_id, event_type, session):
            if event_type == "Balance":
                return [{"yearEnding": "2026-03-31", "inventories": 100.0,
                          "tradeReceivables": 200.0, "tradePayables": 50.0}]
            return [
                {"yearEnding": "2026-03-31", "totalIncome": 1000.0, "totalExpenses": 700.0},
                {"yearEnding": "2025-12-31", "totalIncome": 950.0, "totalExpenses": 680.0},
                {"yearEnding": "2025-09-30", "totalIncome": 900.0, "totalExpenses": 650.0},
                {"yearEnding": "2025-06-30", "totalIncome": 850.0, "totalExpenses": 620.0},
            ]

        monkeypatch.setattr(wcf, "fetch_et_stats", fake_fetch_et_stats)
        monkeypatch.setattr(wcf, "upsert_wc_history", lambda *a, **k: None)
        monkeypatch.setattr(wcf, "update_technical_signals", fake_update_technical_signals)

        wcf.process_stock("RELIANCE", "500325", "2026-07-24", MagicMock(), MagicMock())

        assert recorded["today"] == "2026-07-24"
