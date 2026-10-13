"""risk_free_rate — single source of truth for the platform's annual risk-free rate.

Regression suite for AF-20261011-09 (docs/audit-findings.md): before this module existed the
rate was hard-coded four different ways — 4.0% in quantScoringWorker.ts, 6.5% fallback in
risk_metrics_engine.py, 7.0% in institutional_quant_engine.py and 7.0% in
backend-python/portfolio_analytics.py — so `sharpe_ratio` values written into ONE column were
not comparable row to row. A 1.5pp spread on the numerator is ~0.2 Sharpe points at 30% vol,
larger than most real cross-sectional dispersion.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import risk_free_rate as rfr


class TestNormalizeRate:
    """Percent-vs-decimal scale detection, and the reject set."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            (6.5, 0.065),      # stored as percent
            (6.55, 0.0655),
            (5.4, 0.054),
            (0.065, 0.065),    # already decimal
            ("6.5", 0.065),    # TEXT column coming back as str
            (1.0, 0.01),       # boundary: exactly 1.0 is percent, not decimal
        ],
    )
    def test_accepts_both_scales(self, raw, expected):
        assert rfr.normalize_rate(raw) == pytest.approx(expected)

    @pytest.mark.parametrize(
        "raw",
        [None, "", "NA", "abc", 0, 0.0, -0.5, -6.5, float("nan"), float("inf"), [6.5], {}],
    )
    def test_rejects_unusable(self, raw):
        """Every unusable input must return None, never a silently substituted number —
        get_risk_free_annual's `is not None` gate is the only thing that stops a garbage
        macro row from becoming the platform-wide risk-free rate."""
        assert rfr.normalize_rate(raw) is None


class TestGetRiskFreeAnnual:
    def test_uses_latest_macro_repo_rate(self):
        seen = []

        def fake_query_one(sql):
            seen.append(sql)
            return (5.5,)

        assert rfr.get_risk_free_annual(fake_query_one) == pytest.approx(0.055)
        assert len(seen) == 1
        assert "RBI_REPO_RATE" in seen[0]

    def test_falls_back_to_default_when_no_row(self):
        assert rfr.get_risk_free_annual(lambda sql: None) == rfr.DEFAULT_RISK_FREE_ANNUAL

    def test_falls_back_to_default_when_row_is_unusable(self):
        """A corrupt macro value must fall back to the documented 6.5%, not propagate."""
        assert rfr.get_risk_free_annual(lambda sql: (0,)) == rfr.DEFAULT_RISK_FREE_ANNUAL
        assert rfr.get_risk_free_annual(lambda sql: ("NA",)) == rfr.DEFAULT_RISK_FREE_ANNUAL

    def test_falls_back_to_default_when_query_raises(self):
        def boom(sql):
            raise RuntimeError("macro table unavailable")

        assert rfr.get_risk_free_annual(boom) == rfr.DEFAULT_RISK_FREE_ANNUAL

    def test_default_is_the_documented_repo_midpoint(self):
        assert rfr.DEFAULT_RISK_FREE_ANNUAL == pytest.approx(0.065)


class TestCrossLanguageConstantParity:
    """riskFreeRate.ts must keep the SAME default as the Python module, or the two halves of
    the pipeline again rank against different risk-free rates — the exact defect this module
    was created to close."""

    def test_ts_default_matches_python(self):
        ts = Path(__file__).resolve().parents[3] / "src" / "server" / "riskFreeRate.ts"
        source = ts.read_text(encoding="utf-8")
        assert "export const DEFAULT_RISK_FREE_ANNUAL = 0.065" in source

    def test_no_hard_coded_risk_free_literals_in_sharpe_writers(self):
        """The four hard-coded rates from AF-20261011-09 must be gone from the writers."""
        offenders = {
            "src/server/quantScoringWorker.ts": ["const RISK_FREE = 0.04", "const RISK_FREE=0.04"],
            "src/server/institutional_quant_engine.py": ["risk_free_pct = 7.0", "= 0.07"],
        }
        repo = Path(__file__).resolve().parents[3]
        for relpath, needles in offenders.items():
            source = (repo / relpath).read_text(encoding="utf-8")
            for needle in needles:
                assert needle not in source, f"{relpath} still hard-codes {needle!r}"

    def test_writers_import_the_shared_module(self):
        repo = Path(__file__).resolve().parents[3]
        py = (repo / "src/server/institutional_quant_engine.py").read_text(encoding="utf-8")
        assert "from risk_free_rate import get_risk_free_annual" in py
        ts = (repo / "src/server/quantScoringWorker.ts").read_text(encoding="utf-8")
        assert "riskFreeAnnual" in ts, "worker must receive the injected rate, not a literal"
