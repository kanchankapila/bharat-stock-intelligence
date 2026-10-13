"""Single source of truth for the platform's annual risk-free rate.

Every Sharpe/Sortino/Treynor computation must use the SAME risk-free rate or the
resulting ranks are not comparable across rows. Before this module existed the
rate was hard-coded four different ways: 4.0% in quantScoringWorker.ts, 6.5%
fallback in risk_metrics_engine.py, 7.0% in institutional_quant_engine.py and
7.0% in backend-python/portfolio_analytics.py (2026-10-11 quant audit).

Convention: the latest RBI repo rate from macro_asset_prices (written daily by
global_macro_fetcher.py), falling back to 6.5% (the modern repo-rate mid-point)
when the macro table is unavailable. Stored values are percent (e.g. 6.5);
values below 1.0 are treated as already-decimal to tolerate either scale.
"""
import math
from typing import Optional

DEFAULT_RISK_FREE_ANNUAL = 0.065


def normalize_rate(raw) -> Optional[float]:
    """Percent (6.5) or decimal (0.065) -> decimal. None/zero -> None."""
    try:
        rate = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(rate) or rate <= 0:
        return None
    # Exactly 1.0 is the realistic 1% percent-scale boundary, not a 100% annual rate.
    return rate / 100.0 if rate >= 1.0 else rate


def get_risk_free_annual(query_one=None) -> float:
    """Annual decimal risk-free rate. Reads macro RBI_REPO_RATE; falls back to 6.5%."""
    if query_one is None:
        from db_compat import query_one as _qo
        query_one = _qo
    try:
        row = query_one(
            "SELECT close FROM macro_asset_prices WHERE symbol='RBI_REPO_RATE' "
            "ORDER BY date DESC LIMIT 1"
        )
        rate = normalize_rate(row[0] if row else None)
        if rate is not None:
            return rate
    except Exception:
        pass
    return DEFAULT_RISK_FREE_ANNUAL
