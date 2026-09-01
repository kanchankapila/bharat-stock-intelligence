#!/usr/bin/env python3
"""
Financial Ratios Fetcher — FCF Yield (approx) + Interest Coverage
===================================================================
Rewritten 2026-07-04: the Trendlyne chart-data params this used to depend on
(CFO_Q, CAPEX_Q, EBIT_Q, INT_EXP_Q) are confirmed dead (live-tested, with and
without an authenticated Trendlyne session — Trendlyne retired this param
family, not a rate limit). Replaced with etmarketsapis.indiatimes.com's
ET_Stats mobile endpoint (see et_stats_client.py), keyed by each stock's ET
`companyid` (from scripts/stocklist.json) instead of Trendlyne's `tlid`.

  Interest Coverage = read directly from ET_Stats Ratio.interestCoverage
                       (ET computes this for us — no manual EBIT/interest
                       derivation needed).
  FCF Yield (approx) = (CFO + CFI) / market_cap * 100
                       No CAPEX line item was found in MC, Trendlyne, ET, or
                       Tickertape for this platform's stock universe — CFI
                       (net cash used in investing activities, ET_Stats
                       CashFlow.netCashUsedInInvestingActivities) is used as
                       a CAPEX proxy since it's CAPEX-dominated for most
                       non-financial companies. Clearly labeled "_approx" in
                       every column/field name so downstream consumers know
                       this is an approximation, not a precise FCF figure.

2026-07-23 harvest extension: the same Ratio/CashFlow payloads carry ~40 more
fields we already pay the network cost for but discard. Added:
  - Banking-only ratios (null for cType="NonBank", populated for cType="Bank" —
    live-verified against HDFCBANK): NIM, Cost-to-Income, CASA-adjacent
    earning-asset ratios, Capital Adequacy + Tier 1/2, Gross/Net NPA (+ NPA to
    Advances), branch count, and per-employee/per-branch productivity ratios.
    `numberOfEmployees`/`npAfterMIPerEmployee`/`npAfterMIPerBranches` are
    DELIBERATELY not harvested — live-verified unreliable (0 or null even for
    a well-covered stock like HDFCBANK).
  - Universal: Interest Coverage Post Tax, LT Debt/Equity, CFI/CFF YoY growth
    (cashflow already fetched at last=6 now, not 5, so 3Y/5Y CAGR for
    CFO/CFI/CFF can be computed from the same response — no extra network
    call).

Cadence: monthly (Balance/CashFlow/Ratio are annual-refresh ET_Stats data —
no value in fetching more often than once a month).

Writes:
  tl_financial_quality  (symbol, as_of_date) — raw + derived values
  et_cashflow_history   (symbol, year_ending) — full 6-year annual CFO/CFI/CFF series
                          per stock (2026-09-01: the CashFlow payload was already fetched
                          at last=6 but only period [0] was persisted — the other 5 annual
                          periods were discarded. This table keeps them all, giving the
                          platform its first real multi-year annual cash-flow history and
                          enabling FCF-trend/stability features at zero extra network cost.)
  technical_signals     — fcf_yield_approx, interest_coverage, fcf_positive,
                          debt_coverage_risk, + the harvested fields above

Run:
  python financial_ratios_fetcher.py              # all stocks with a companyid
  python financial_ratios_fetcher.py --symbol BEL
  python financial_ratios_fetcher.py --limit 50
"""

import polars as pl

import argparse
from datetime import date

import requests

from db_compat import connect
from as_of import logical_write_floor
from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map, as_of_floor
import sys

DEBT_COVERAGE_RISK_THRESHOLD = 1.5


# ── Schema ──────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tl_financial_quality (
            symbol               TEXT NOT NULL,
            as_of_date           TEXT NOT NULL,
            cfo_ttm              REAL,
            cfi_ttm              REAL,
            fcf_ttm_approx       REAL,
            interest_coverage    REAL,
            market_cap           REAL,
            fcf_yield_approx     REAL,
            fetched_at           TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, as_of_date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_tlfq_sym
        ON tl_financial_quality(symbol, as_of_date DESC)
    """)
    # 2026-09-01: full annual cash-flow series (was: only period [0] of the last=6 payload
    # survived, the rest discarded). One row per (symbol, fiscal-year-end).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS et_cashflow_history (
            symbol       TEXT NOT NULL,
            year_ending  TEXT NOT NULL,
            cfo          REAL,
            cfi          REAL,
            cff          REAL,
            fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, year_ending)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_ecf_sym
        ON et_cashflow_history(symbol, year_ending DESC)
    """)
    con.commit()

    # KNOWN DEAD-BY-DESIGN COLUMNS (investigated 2026-08-07, dead-column sweep -- not a bug,
    # documented so a future session doesn't re-flag or try to "fix" them): live Postgres also
    # carries capex_ttm/ebit_ttm/fcf_ttm/fcf_yield/interest_expense_ttm on this table (added by
    # an earlier migration, outside this file's own ensure_schema()/ALTER block above, which is
    # why they're absent from it). fcf_ttm/fcf_yield are the pre-"_approx" originals --
    # superseded by fcf_ttm_approx/fcf_yield_approx (the same "Task 11" supersession already
    # documented in pgClient.ts for technical_signals.fcf_yield). capex_ttm/ebit_ttm/
    # interest_expense_ttm were raw per-line-item inputs to a more granular FCF formula that
    # was abandoned in favor of the simpler fcf_ttm_approx = cfo_ttm + cfi_ttm this file
    # actually computes. None of the 5 have ever been written by this fetcher; do not build new
    # logic to populate them -- that would resurrect a design this file has already moved past.

    for ddl in [
        "ALTER TABLE tl_financial_quality ADD COLUMN fetched_at TEXT DEFAULT CURRENT_TIMESTAMP",
        # Ratio-harvest columns: the Ratio/CashFlow payloads we already fetch expose ~40 ratios
        # over 5 years and we only read interestCoverage. Harvest the orthogonal-to-
        # fundamentals_history ones (which already has ROE/D-E/margins/growth): ROCE + its YoY
        # trend, quick ratio, EV/EBITDA, asset turnover, CFO growth.
        "ALTER TABLE tl_financial_quality ADD COLUMN roce           REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN roce_trend     REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN quick_ratio    REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN ev_ebitda      REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN asset_turnover REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cfo_growth     REAL",
        "ALTER TABLE technical_signals ADD COLUMN fcf_yield_approx   REAL",
        "ALTER TABLE technical_signals ADD COLUMN interest_coverage  REAL",
        "ALTER TABLE technical_signals ADD COLUMN fcf_positive       INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN debt_coverage_risk INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN roce               REAL",
        "ALTER TABLE technical_signals ADD COLUMN roce_trend         REAL",
        "ALTER TABLE technical_signals ADD COLUMN quick_ratio        REAL",
        "ALTER TABLE technical_signals ADD COLUMN ev_ebitda          REAL",
        "ALTER TABLE technical_signals ADD COLUMN asset_turnover     REAL",
        "ALTER TABLE technical_signals ADD COLUMN cfo_growth         REAL",
        # ── 2026-07-23 harvest: banking ratios (bank-only, NULL for non-banks) ──
        "ALTER TABLE tl_financial_quality ADD COLUMN nim                        REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cost_to_income             REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN int_income_earning_assets  REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN non_int_income_earning_assets REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN op_profit_earning_assets   REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN op_expense_earning_assets  REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN int_exp_earning_assets     REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN capital_adequacy           REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN tier1_capital              REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN tier2_capital              REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN gross_npa_pct              REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN net_npa_pct                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN net_npa_to_advances        REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN num_branches               REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN int_income_per_employee    REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN np_per_employee            REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN business_per_employee      REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN int_income_per_branch      REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN np_per_branch              REAL",
        # ── 2026-07-23 harvest: universal solvency / cash-flow-growth ──
        "ALTER TABLE tl_financial_quality ADD COLUMN interest_coverage_post_tax REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN lt_de_ratio                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cfi_growth                 REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cff_growth                 REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cfo_cagr_3y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cfi_cagr_3y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cff_cagr_3y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cfo_cagr_5y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cfi_cagr_5y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN cff_cagr_5y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN nim                        REAL",
        "ALTER TABLE technical_signals ADD COLUMN cost_to_income             REAL",
        "ALTER TABLE technical_signals ADD COLUMN int_income_earning_assets  REAL",
        "ALTER TABLE technical_signals ADD COLUMN non_int_income_earning_assets REAL",
        "ALTER TABLE technical_signals ADD COLUMN op_profit_earning_assets   REAL",
        "ALTER TABLE technical_signals ADD COLUMN op_expense_earning_assets  REAL",
        "ALTER TABLE technical_signals ADD COLUMN int_exp_earning_assets     REAL",
        "ALTER TABLE technical_signals ADD COLUMN capital_adequacy           REAL",
        "ALTER TABLE technical_signals ADD COLUMN tier1_capital              REAL",
        "ALTER TABLE technical_signals ADD COLUMN tier2_capital              REAL",
        "ALTER TABLE technical_signals ADD COLUMN gross_npa_pct              REAL",
        "ALTER TABLE technical_signals ADD COLUMN net_npa_pct                REAL",
        "ALTER TABLE technical_signals ADD COLUMN net_npa_to_advances        REAL",
        "ALTER TABLE technical_signals ADD COLUMN num_branches               REAL",
        "ALTER TABLE technical_signals ADD COLUMN int_income_per_employee    REAL",
        "ALTER TABLE technical_signals ADD COLUMN np_per_employee            REAL",
        "ALTER TABLE technical_signals ADD COLUMN business_per_employee      REAL",
        "ALTER TABLE technical_signals ADD COLUMN int_income_per_branch      REAL",
        "ALTER TABLE technical_signals ADD COLUMN np_per_branch              REAL",
        "ALTER TABLE technical_signals ADD COLUMN interest_coverage_post_tax REAL",
        "ALTER TABLE technical_signals ADD COLUMN lt_de_ratio                REAL",
        "ALTER TABLE technical_signals ADD COLUMN cfi_growth                 REAL",
        "ALTER TABLE technical_signals ADD COLUMN cff_growth                 REAL",
        "ALTER TABLE technical_signals ADD COLUMN cfo_cagr_3y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN cfi_cagr_3y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN cff_cagr_3y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN cfo_cagr_5y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN cfi_cagr_5y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN cff_cagr_5y                REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Pure computation (fully unit-testable, no network/DB) ───────────────────────

def _num(v, default=None):
    """Coerce an ET_Stats field to float; ET returns the literal 'NA' for missing values,
    which otherwise reaches the `interest_coverage < threshold` compare as a str and raises."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _cagr(latest: float | None, base: float | None, years: int) -> float | None:
    """Compound annual growth from `base` (N years ago) to `latest` (now), as a percentage.
    None whenever the result would be undefined/meaningless: either value missing, `base`
    non-positive (fractional power of a negative number is not real), or `latest` non-positive
    (a positive-to-negative or negative-to-negative swing has no sensible CAGR). This makes CFI/
    CFF CAGR frequently None in practice — those lines are routinely negative (cash outflow),
    which is a data-honesty null, not a bug (same philosophy as is_plausible_return() elsewhere
    in this project: an undefined stat is reported as missing, never as a garbage number)."""
    if latest is None or base is None or base <= 0 or latest <= 0 or years <= 0:
        return None
    try:
        return round(((latest / base) ** (1.0 / years) - 1.0) * 100, 2)
    except (ValueError, ZeroDivisionError):
        return None


def compute_ratios(
    balance: list[dict] | None,
    cashflow: list[dict] | None,
    ratio: list[dict] | None,
    market_cap: float | None,
) -> dict:
    """All four ET_Stats event lists are most-recent-first; index 0 is the
    latest available period. `balance` is accepted for interface symmetry
    with working_capital_fetcher.py but unused here."""
    cfo = _num(cashflow[0].get("netCashFlowFromOperatingActivities")) if cashflow else None
    cfi = _num(cashflow[0].get("netCashUsedInInvestingActivities")) if cashflow else None
    interest_coverage = _num(ratio[0].get("interestCoverage")) if ratio else None
    # Fiscal-year-end of the figures above (most-recent-first); drives the as-of stamp floor so
    # these values are only written onto signal rows dated after the results were published.
    year_ending = (cashflow[0].get("yearEnding") if cashflow else None) or (ratio[0].get("yearEnding") if ratio else None)

    # ── Ratio harvest (same payload, previously discarded) ──────────────────────────
    r0 = ratio[0] if ratio else {}
    r1 = ratio[1] if ratio and len(ratio) > 1 else {}
    roce = _num(r0.get("roce"))
    roce_prev = _num(r1.get("roce"))
    roce_trend = round(roce - roce_prev, 2) if roce is not None and roce_prev is not None else None
    quick_ratio = _num(r0.get("quickRatio"))
    ev_ebitda = _num(r0.get("evPerEBITDA"))
    asset_turnover = _num(r0.get("assetTurnover"))
    cfo_growth = _num(cashflow[0].get("cfoGrowth")) if cashflow else None

    # ── 2026-07-23 harvest: universal solvency (same Ratio payload) ─────────────────
    interest_coverage_post_tax = _num(r0.get("interestCoveragePostTax"))
    lt_de_ratio = _num(r0.get("longTermDebtEquity"))

    # ── 2026-07-23 harvest: banking-only ratios. NULL for cType="NonBank" — that's the
    # ET_Stats provider's own classification, not a parsing failure; every field below is
    # expected to be None for ~95% of the universe (non-bank/non-NBFC stocks). Live-verified
    # against HDFCBANK (cType="Bank"): nim=2.94, costToIncome=37.99, capitalAdequacyRatios=19.71.
    # `numberOfEmployees`/`npAfterMIPerEmployee`/`npAfterMIPerBranches` are deliberately NOT
    # harvested — live-verified unreliable (0 or null even for HDFCBANK).
    nim = _num(r0.get("nim"))
    cost_to_income = _num(r0.get("costToIncome"))
    int_income_earning_assets = _num(r0.get("interestIncomeByEarningAssets"))
    non_int_income_earning_assets = _num(r0.get("nonInterestIncomeByEarningAssets"))
    op_profit_earning_assets = _num(r0.get("operatingProfitByEarningAssets"))
    op_expense_earning_assets = _num(r0.get("operatingExpensesByEarningAssets"))
    int_exp_earning_assets = _num(r0.get("interestExpensesByEarningAssets"))
    capital_adequacy = _num(r0.get("capitalAdequacyRatios"))
    tier1_capital = _num(r0.get("keyPerformanceTier1"))
    tier2_capital = _num(r0.get("keyPerformanceTier2"))
    gross_npa_pct = _num(r0.get("grossNPAPercentage"))
    net_npa_pct = _num(r0.get("netNPAPercentage"))
    net_npa_to_advances = _num(r0.get("netNPAToAdvancesPercentage"))
    num_branches = _num(r0.get("numberOfBranches"))
    int_income_per_employee = _num(r0.get("interestIncomePerEmployee"))
    np_per_employee = _num(r0.get("npPerEmployee"))
    business_per_employee = _num(r0.get("businessPerEmployee"))
    int_income_per_branch = _num(r0.get("interestIncomePerBranch"))
    np_per_branch = _num(r0.get("npPerBranches"))

    # ── 2026-07-23 harvest: CFI/CFF YoY growth + 3Y/5Y CAGR for CFO/CFI/CFF. Needs cashflow
    # fetched at last=6 (index 3 = 3 years back, index 5 = 5 years back); process_stock() below
    # requests last=6 for exactly this. Falls back to None (not a crash) if fewer periods came back.
    cfi_growth = _num(cashflow[0].get("cfiGrowth")) if cashflow else None
    cff_growth = _num(cashflow[0].get("cffGrowth")) if cashflow else None

    def _cf_cagr(field: str, years: int) -> float | None:
        if not cashflow or len(cashflow) <= years:
            return None
        latest = _num(cashflow[0].get(field))
        base = _num(cashflow[years].get(field))
        return _cagr(latest, base, years)

    cfo_cagr_3y = _cf_cagr("netCashFlowFromOperatingActivities", 3)
    cfi_cagr_3y = _cf_cagr("netCashUsedInInvestingActivities", 3)
    cff_cagr_3y = _cf_cagr("netCashUsedFromFinancingActivities", 3)
    cfo_cagr_5y = _cf_cagr("netCashFlowFromOperatingActivities", 5)
    cfi_cagr_5y = _cf_cagr("netCashUsedInInvestingActivities", 5)
    cff_cagr_5y = _cf_cagr("netCashUsedFromFinancingActivities", 5)

    fcf_ttm_approx: float | None = None
    if cfo is not None and cfi is not None:
        fcf_ttm_approx = round(float(cfo) + float(cfi), 2)

    fcf_yield_approx: float | None = None
    if fcf_ttm_approx is not None and market_cap and market_cap > 0:
        fcf_yield_approx = round(fcf_ttm_approx / market_cap * 100, 4)

    fcf_positive = 1 if (fcf_ttm_approx is not None and fcf_ttm_approx > 0) else (0 if fcf_ttm_approx is not None else None)
    debt_coverage_risk = (
        1 if (interest_coverage is not None and interest_coverage < DEBT_COVERAGE_RISK_THRESHOLD) else
        (0 if interest_coverage is not None else None)
    )

    return {
        "cfo_ttm": round(float(cfo), 2) if cfo is not None else None,
        "cfi_ttm": round(float(cfi), 2) if cfi is not None else None,
        "fcf_ttm_approx": fcf_ttm_approx,
        "interest_coverage": round(float(interest_coverage), 2) if interest_coverage is not None else None,
        "market_cap": round(float(market_cap), 2) if market_cap is not None else None,
        "fcf_yield_approx": fcf_yield_approx,
        "fcf_positive": fcf_positive,
        "debt_coverage_risk": debt_coverage_risk,
        "year_ending": year_ending,
        "roce": round(roce, 2) if roce is not None else None,
        "roce_trend": roce_trend,
        "quick_ratio": round(quick_ratio, 2) if quick_ratio is not None else None,
        "ev_ebitda": round(ev_ebitda, 2) if ev_ebitda is not None else None,
        "asset_turnover": round(asset_turnover, 2) if asset_turnover is not None else None,
        "cfo_growth": round(cfo_growth, 2) if cfo_growth is not None else None,
        "interest_coverage_post_tax": round(interest_coverage_post_tax, 2) if interest_coverage_post_tax is not None else None,
        "lt_de_ratio": round(lt_de_ratio, 2) if lt_de_ratio is not None else None,
        "nim": round(nim, 2) if nim is not None else None,
        "cost_to_income": round(cost_to_income, 2) if cost_to_income is not None else None,
        "int_income_earning_assets": round(int_income_earning_assets, 2) if int_income_earning_assets is not None else None,
        "non_int_income_earning_assets": round(non_int_income_earning_assets, 2) if non_int_income_earning_assets is not None else None,
        "op_profit_earning_assets": round(op_profit_earning_assets, 2) if op_profit_earning_assets is not None else None,
        "op_expense_earning_assets": round(op_expense_earning_assets, 2) if op_expense_earning_assets is not None else None,
        "int_exp_earning_assets": round(int_exp_earning_assets, 2) if int_exp_earning_assets is not None else None,
        "capital_adequacy": round(capital_adequacy, 2) if capital_adequacy is not None else None,
        "tier1_capital": round(tier1_capital, 2) if tier1_capital is not None else None,
        "tier2_capital": round(tier2_capital, 2) if tier2_capital is not None else None,
        "gross_npa_pct": round(gross_npa_pct, 2) if gross_npa_pct is not None else None,
        "net_npa_pct": round(net_npa_pct, 2) if net_npa_pct is not None else None,
        "net_npa_to_advances": round(net_npa_to_advances, 2) if net_npa_to_advances is not None else None,
        "num_branches": round(num_branches, 0) if num_branches is not None else None,
        "int_income_per_employee": round(int_income_per_employee, 4) if int_income_per_employee is not None else None,
        "np_per_employee": round(np_per_employee, 4) if np_per_employee is not None else None,
        "business_per_employee": round(business_per_employee, 4) if business_per_employee is not None else None,
        "int_income_per_branch": round(int_income_per_branch, 4) if int_income_per_branch is not None else None,
        "np_per_branch": round(np_per_branch, 4) if np_per_branch is not None else None,
        "cfi_growth": round(cfi_growth, 2) if cfi_growth is not None else None,
        "cff_growth": round(cff_growth, 2) if cff_growth is not None else None,
        "cfo_cagr_3y": cfo_cagr_3y,
        "cfi_cagr_3y": cfi_cagr_3y,
        "cff_cagr_3y": cff_cagr_3y,
        "cfo_cagr_5y": cfo_cagr_5y,
        "cfi_cagr_5y": cfi_cagr_5y,
        "cff_cagr_5y": cff_cagr_5y,
    }


def parse_cashflow_series(cashflow: list[dict] | None) -> list[dict]:
    """Flatten the ET_Stats CashFlow payload (last=6 annual periods) into one row-dict per
    fiscal year: {"year_ending", "cfo", "cfi", "cff"}. Pure — no network/DB.

    Kept periods are those with a parseable ISO yearEnding AND at least one non-None cash-flow
    figure; fully-empty periods are dropped rather than stored as all-NULL rows (same honest-
    unknown rule the rest of this file follows). Values are rounded to 2dp like every other
    number this fetcher persists."""
    rows: list[dict] = []
    for period in cashflow or []:
        if not isinstance(period, dict):
            continue
        raw_ye = period.get("yearEnding")
        if not raw_ye:
            continue
        try:
            year_ending = date.fromisoformat(str(raw_ye)[:10]).isoformat()
        except (ValueError, TypeError):
            continue
        cfo = _num(period.get("netCashFlowFromOperatingActivities"))
        cfi = _num(period.get("netCashUsedInInvestingActivities"))
        cff = _num(period.get("netCashUsedFromFinancingActivities"))
        if cfo is None and cfi is None and cff is None:
            continue
        rows.append({
            "year_ending": year_ending,
            "cfo": round(float(cfo), 2) if cfo is not None else None,
            "cfi": round(float(cfi), 2) if cfi is not None else None,
            "cff": round(float(cff), 2) if cff is not None else None,
        })
    return rows


# ── Persist ──────────────────────────────────────────────────────────────────────

_HARVEST_COLUMNS = [
    "roce", "roce_trend", "quick_ratio", "ev_ebitda", "asset_turnover", "cfo_growth",
    "interest_coverage_post_tax", "lt_de_ratio",
    "nim", "cost_to_income", "int_income_earning_assets", "non_int_income_earning_assets",
    "op_profit_earning_assets", "op_expense_earning_assets", "int_exp_earning_assets",
    "capital_adequacy", "tier1_capital", "tier2_capital",
    "gross_npa_pct", "net_npa_pct", "net_npa_to_advances", "num_branches",
    "int_income_per_employee", "np_per_employee", "business_per_employee",
    "int_income_per_branch", "np_per_branch",
    "cfi_growth", "cff_growth",
    "cfo_cagr_3y", "cfi_cagr_3y", "cff_cagr_3y", "cfo_cagr_5y", "cfi_cagr_5y", "cff_cagr_5y",
]


def upsert_quality(symbol: str, today: str, row: dict, con) -> None:
    cur = con.cursor()
    columns = ["symbol", "as_of_date", "cfo_ttm", "cfi_ttm", "fcf_ttm_approx",
               "interest_coverage", "market_cap", "fcf_yield_approx"] + _HARVEST_COLUMNS
    placeholders = ",".join(["?"] * len(columns))
    update_clause = ",\n            ".join(
        f"{c} = excluded.{c}" for c in columns if c not in ("symbol", "as_of_date")
    )
    cur.execute(f"""
        INSERT INTO tl_financial_quality ({", ".join(columns)})
        VALUES ({placeholders})
        ON CONFLICT(symbol, as_of_date) DO UPDATE SET
            {update_clause},
            fetched_at = CURRENT_TIMESTAMP
    """, tuple(symbol if c == "symbol" else today if c == "as_of_date" else row.get(c) for c in columns))
    con.commit()


def upsert_cashflow_history(symbol: str, rows: list[dict], con) -> None:
    """Persist the full annual CFO/CFI/CFF series into et_cashflow_history. Idempotent per
    (symbol, year_ending): re-runs refresh the figures in place (annual ET data only changes
    on restatement), so weekly runs converge instead of accumulating rows."""
    if not rows:
        return
    cur = con.cursor()
    cur.executemany("""
        INSERT INTO et_cashflow_history (symbol, year_ending, cfo, cfi, cff)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (symbol, year_ending) DO UPDATE SET
            cfo = excluded.cfo,
            cfi = excluded.cfi,
            cff = excluded.cff,
            fetched_at = CURRENT_TIMESTAMP
    """, [(symbol, r["year_ending"], r["cfo"], r["cfi"], r["cff"]) for r in rows])
    con.commit()


def update_technical_signals(symbol: str, features: dict, con, today: str | None = None) -> None:
    # Point-in-time stamp: apply these annual figures only to rows on/after the results were
    # published (date >= floor), and NULL them on older rows. A plain `WHERE symbol = ?` smeared
    # the latest annual value across the symbol's whole history, leaking future fundamentals into
    # the per-signal-date feature join in ml_ensemble/exit_policy. The as-of trail lives in
    # tl_financial_quality; technical_signals only carries the value from its knowable date on.
    floor = as_of_floor(features.get("year_ending"), fallback=today)
    cur = con.cursor()
    base_columns = ["fcf_yield_approx", "interest_coverage", "fcf_positive", "debt_coverage_risk"] + _HARVEST_COLUMNS
    set_clause = ",\n            ".join(
        f"{c} = CASE WHEN date >= ? THEN COALESCE(?, {c}) ELSE NULL END" for c in base_columns
    )
    params = []
    for c in base_columns:
        params.extend([floor, features.get(c)])
    params.append(symbol)
    cur.execute(f"""
        UPDATE technical_signals SET
            {set_clause}
        WHERE symbol = ?
    """, tuple(params))
    con.commit()


def get_market_cap(symbol: str, con) -> float | None:
    cur = con.cursor()
    cur.execute("SELECT market_cap FROM stock_fundamentals WHERE symbol = ?", (symbol,))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else None


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, company_id: str, today: str,
                   session: requests.Session, con) -> dict:
    cashflow = fetch_et_stats(company_id, "CashFlow", session, last=6)  # 6 periods -> 5Y CAGR possible
    ratio = fetch_et_stats(company_id, "Ratio", session)
    market_cap = get_market_cap(symbol, con)

    features = compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=market_cap)

    upsert_quality(symbol, today, features, con)
    upsert_cashflow_history(symbol, parse_cashflow_series(cashflow), con)
    update_technical_signals(symbol, features, con, today=today)
    return features


# ── Stock list ────────────────────────────────────────────────────────────────────

def load_stocks(symbol_filter: str | None, limit: int | None) -> list[tuple[str, str]]:
    """Return [(symbol, company_id), ...] from scripts/stocklist.json."""
    company_map = load_companyid_map()
    rows = sorted(company_map.items())
    if symbol_filter:
        rows = [(s, c) for s, c in rows if s == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="FCF yield (approx) + interest coverage from ET_Stats")
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[FinancialRatios] No stocks with a companyid found.")
        con.close()
        return

    print(f"[FinancialRatios] Processing {len(stocks)} stocks — FCF yield (approx) + interest coverage…")
    session = requests.Session()
    session.headers.update(HEADERS)
    # Align to the last completed trading session, NOT date.today() -- this job runs in the
    # trendlyne-ratios-monthly batch (first Sunday of the month), a non-trading day with no
    # technical_signals row yet. Same fix as trendlyne_fundamentals_fetcher.py / mf_holdings_fetcher.py.
    today = logical_write_floor(con, fallback=date.today().isoformat())

    ok = 0
    fcf_positive_count = 0
    distress_count = 0

    for i, (symbol, company_id) in enumerate(stocks, 1):
        try:
            features = process_stock(symbol, company_id, today, session, con)
            ok += 1

            if features.get("fcf_positive"):
                fcf_positive_count += 1
            if features.get("debt_coverage_risk"):
                distress_count += 1

            fcf_str = f"FCF yield~{features['fcf_yield_approx']:.2f}%" if features.get("fcf_yield_approx") is not None else "FCF yield=n/a"
            cov_str = f"IC={features['interest_coverage']:.1f}x" if features.get("interest_coverage") is not None else "IC=n/a"
            flag = " [DISTRESS]" if features.get("debt_coverage_risk") else ""
            print(f"  [{i}/{len(stocks)}] {symbol}: {fcf_str} | {cov_str}{flag}")

        except Exception as e:
            try:
                con.rollback()
            except Exception:
                pass
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}", file=sys.stderr)

    fcf_pct = round(fcf_positive_count / ok * 100) if ok else 0
    print(
        f"[FinancialRatios] Done. {ok} stocks. "
        f"FCF positive: {fcf_pct}%. "
        f"Interest coverage distress (<{DEBT_COVERAGE_RISK_THRESHOLD}x): {distress_count} stocks."
    )
    con.close()


if __name__ == "__main__":
    main()

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class FinancialRatiosFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class FinancialRatiosFetcherBaseFetcher(BaseFetcher[FinancialRatiosFetcherSchema]):
    fetcher_name = 'FinancialRatiosFetcher'
    domain = 'general'
    schema = FinancialRatiosFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
