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
  FCF Yield (approx) = ((CFO + CFI) in INR crore * 10^7) / market_cap_in_INR * 100
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


import argparse
from datetime import date, timedelta

import requests

from db_compat import connect
from as_of import logical_write_floor
from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map, as_of_floor
from fetch_utils import FetchTracker
import sys

DEBT_COVERAGE_RISK_THRESHOLD = 1.5
INR_PER_CRORE = 10_000_000.0


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
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS fetched_at TEXT DEFAULT CURRENT_TIMESTAMP",
        # Ratio-harvest columns: the Ratio/CashFlow payloads we already fetch expose ~40 ratios
        # over 5 years and we only read interestCoverage. Harvest the orthogonal-to-
        # fundamentals_history ones (which already has ROE/D-E/margins/growth): ROCE + its YoY
        # trend, quick ratio, EV/EBITDA, asset turnover, CFO growth.
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS roce           REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS roce_trend     REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS quick_ratio    REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS ev_ebitda      REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS asset_turnover REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cfo_growth     REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_yield_approx   REAL",
        # 2026-10-11 quant audit: label recording WHICH FCF definition produced the row's
        # fcf_yield_approx -- "capex" (four quarters of real CFO - CapEx) or
        # "cfo_cfi_proxy" (the CFO+CFI fallback). Without it the two bases are silently
        # mixed in one column and a capex-heavy grower reads as a cash burner.
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS fcf_basis        TEXT",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS fcf_ttm_as_of    TEXT",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_basis            TEXT",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_ttm_as_of        TEXT",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS interest_coverage  REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_positive       INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS debt_coverage_risk INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS roce               REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS roce_trend         REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS quick_ratio        REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ev_ebitda          REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS asset_turnover     REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cfo_growth         REAL",
        # ── 2026-07-23 harvest: banking ratios (bank-only, NULL for non-banks) ──
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS nim                        REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cost_to_income             REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS int_income_earning_assets  REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS non_int_income_earning_assets REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS op_profit_earning_assets   REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS op_expense_earning_assets  REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS int_exp_earning_assets     REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS capital_adequacy           REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS tier1_capital              REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS tier2_capital              REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS gross_npa_pct              REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS net_npa_pct                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS net_npa_to_advances        REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS num_branches               REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS int_income_per_employee    REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS np_per_employee            REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS business_per_employee      REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS int_income_per_branch      REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS np_per_branch              REAL",
        # ── 2026-07-23 harvest: universal solvency / cash-flow-growth ──
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS interest_coverage_post_tax REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS lt_de_ratio                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cfi_growth                 REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cff_growth                 REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cfo_cagr_3y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cfi_cagr_3y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cff_cagr_3y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cfo_cagr_5y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cfi_cagr_5y                REAL",
        "ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cff_cagr_5y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS nim                        REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cost_to_income             REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS int_income_earning_assets  REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS non_int_income_earning_assets REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS op_profit_earning_assets   REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS op_expense_earning_assets  REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS int_exp_earning_assets     REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS capital_adequacy           REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS tier1_capital              REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS tier2_capital              REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS gross_npa_pct              REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS net_npa_pct                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS net_npa_to_advances        REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS num_branches               REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS int_income_per_employee    REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS np_per_employee            REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS business_per_employee      REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS int_income_per_branch      REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS np_per_branch              REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS interest_coverage_post_tax REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS lt_de_ratio                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cfi_growth                 REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cff_growth                 REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cfo_cagr_3y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cfi_cagr_3y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cff_cagr_3y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cfo_cagr_5y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cfi_cagr_5y                REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS cff_cagr_5y                REAL",
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


# ── Free cash flow ─────────────────────────────────────────────────────────────
#
# FCF = CFO − CapEx. It is NOT CFO + CFI. CFI nets capex against asset sales,
# acquisitions, disposals of subsidiaries, purchases/sales of investments and
# (for banks/NBFCs) securities-books movement, so "CFO + CFI" answers "how much
# did cash flow after ALL investing activity", which is a different — and for a
# company that just sold a business unit, wildly optimistic — number. Measured
# live 2026-10-11 on the ~2,000-name universe: 395 symbols had CFO > 0 but
# CFO+CFI <= 0 (capex-heavy growth cos. reported as cash-burning) and 104 had
# CFO < 0 but CFO+CFI > 0 (financing-like investing inflows booked as "free"
# cash). Both directions fed `fcf_positive`, `fcf_yield_approx`, the "FCF x%"
# badge and ml_ensemble's quality_score.
#
# Since finstack_cashflow_fetcher.py landed, the platform has REAL quarterly
# capex (finstack_cashflow_history.capex, yfinance-sourced, stored as a NEGATIVE
# number — live-verified: ocf + capex reproduces the vendor's own fcf column
# exactly on every row checked). So TTM FCF is now computed from four quarters of
# true capex wherever that history exists, and CFO+CFI survives only as an
# explicitly-labelled fallback for names Yahoo has no quarterly cash flow for.
# Every row records which of the two it used in `fcf_basis`, so a consumer can
# tell a real FCF from a proxy instead of silently mixing them in one column.

FCF_BASIS_CAPEX = "capex"           # sum of 4 quarters of (CFO − CapEx) — the real thing
FCF_BASIS_PROXY = "cfo_cfi_proxy"   # CFO + CFI — fallback, overstates/understates materially

TTM_QUARTERS = 4
# Consecutive quarterly period-ends sit ~90-95d apart. Allow up to 150d so a
# missing/holiday-shifted quarter in the vendor's series doesn't silently make a
# 3-quarter sum masquerade as a 12-month one.
MAX_QUARTER_GAP_DAYS = 150


def _ttm_fcf_from_quarters(rows, as_of: str | None = None, n_quarters: int = TTM_QUARTERS):
    """TTM FCF from quarterly cash-flow rows: newest-first is not required.

    `rows` is an iterable of mappings/dicts with `period_end` (ISO date str),
    `ocf` and `capex` (capex NEGATIVE, as finstack_cashflow_fetcher stores it).
    Returns (fcf_ttm, latest_period_end) or (None, None) when a genuine
    n-quarter window cannot be established — no partial-sum fabrication, no
    annualising a 3-quarter sum.

    `as_of` (ISO date) restricts the window to periods already published, so a
    point-in-time caller never sees a quarter that hadn't been reported yet.
    Pure function: no DB, no network.
    """
    parsed = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        pe = r.get("period_end")
        ocf = r.get("ocf")
        capex = r.get("capex")
        if not pe or ocf is None or capex is None:
            continue
        try:
            d = date.fromisoformat(str(pe)[:10])
        except (ValueError, TypeError):
            continue
        if as_of and str(pe)[:10] > as_of:
            continue
        parsed.append((d, float(ocf), float(capex)))
    if len(parsed) < n_quarters:
        return None, None
    parsed.sort(key=lambda t: t[0], reverse=True)
    window = parsed[:n_quarters]
    # Contiguity: the oldest and newest of the window must span ~n_quarters-1 quarters,
    # and no adjacent gap inside it may be implausibly wide.
    for older, newer in zip(window[1:], window[:-1]):
        if (newer[0] - older[0]).days > MAX_QUARTER_GAP_DAYS:
            return None, None
    fcf_ttm = round(sum(ocf + capex for _, ocf, capex in window), 2)
    return fcf_ttm, window[0][0].isoformat()


def finstack_ttm_fcf(con, symbol: str, as_of: str | None = None):
    """Read finstack_cashflow_history for `symbol` and return (fcf_ttm, latest_period_end).

    (None, None) when the vendor has no usable quarterly window for this name —
    which is the majority of the universe today (Yahoo covers a subset of NSE
    names, see finstack_cashflow_fetcher.py's docstring). That is an honest
    no-data, not a zero: the caller falls back to the CFO+CFI proxy and labels it.
    """
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT period_end, ocf, capex FROM finstack_cashflow_history "
            "WHERE symbol = ? ORDER BY period_end DESC",
            (symbol,),
        )
        rows = [{"period_end": r[0], "ocf": r[1], "capex": r[2]} for r in cur.fetchall()]
    except Exception:
        return None, None
    finally:
        try:
            cur.close()
        except Exception:
            pass
    return _ttm_fcf_from_quarters(rows, as_of=as_of)



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
        # ET_Stats cash-flow values are INR crore; stock_fundamentals.market_cap is raw INR.
        # Dividing them directly suppressed every proxy yield by exactly 10^7.
        fcf_yield_approx = round(fcf_ttm_approx * INR_PER_CRORE / market_cap * 100, 4)

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
               "interest_coverage", "market_cap", "fcf_yield_approx",
               "fcf_basis", "fcf_ttm_as_of"] + _HARVEST_COLUMNS
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
    # Point-in-time stamp: annual ratios become knowable after the statutory publication lag.
    # The capex-based FCF fields are different: they are assembled from the latest quarterly
    # payload during this fetch, so their first defensible availability date is `today`. Applying
    # those values at the annual floor would leak later quarters into historical model features.
    annual_floor = as_of_floor(features.get("year_ending"), fallback=today)
    fcf_floor = today or date.today().isoformat()
    quarterly_fcf_columns = {
        "fcf_yield_approx", "fcf_positive", "fcf_basis", "fcf_ttm_as_of",
    }
    cur = con.cursor()
    base_columns = ["fcf_yield_approx", "interest_coverage", "fcf_positive", "debt_coverage_risk",
                    "fcf_basis", "fcf_ttm_as_of"] + _HARVEST_COLUMNS
    set_clause = ",\n            ".join(
        f"{c} = CASE WHEN date >= ? THEN COALESCE(?, {c}) ELSE NULL END" for c in base_columns
    )
    params = []
    for c in base_columns:
        floor = fcf_floor if features.get("fcf_basis") == "capex" and c in quarterly_fcf_columns else annual_floor
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
    # fetch_et_stats returns None for an HTTP error as well as an empty payload. Previously that
    # flowed into compute_ratios(), wrote an all/partly-NULL row, and counted the stock as a
    # success. A total ET outage could therefore overwrite useful features across the universe
    # while BullMQ reported a clean job. Both slices are expected for every mapped company (live
    # coverage: 1,969/1,971 latest rows have each family), so reject an incomplete response before
    # any write. The run-level FetchTracker below decides whether isolated misses or an outage
    # should fail the scheduled job.
    missing = [name for name, rows in (("CashFlow", cashflow), ("Ratio", ratio)) if not rows]
    if missing:
        if len(missing) == 2:
            raise RuntimeError("ET_Stats returned no CashFlow or Ratio data")
        raise RuntimeError(f"ET_Stats returned no {missing[0]} data")
    market_cap = get_market_cap(symbol, con)

    features = compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=market_cap)

    # ── Prefer REAL TTM FCF over the CFO+CFI proxy wherever it exists ─────────────
    # compute_ratios() has no DB access, so the quarterly-capex upgrade happens here,
    # after the row is built. Bound the quarterly window by the FETCH date, not the annual
    # fiscal year-end. The old bound rejected every legitimate quarter reported after March
    # (for example June and September), which is why live fcf_ttm_as_of remained 100% NULL
    # even when finstack history contained four usable quarters. `today` is also the earliest
    # safe availability date because this vendor table has period_end/fetched_at, not a filing
    # publication timestamp; using period_end to backfill older signal dates would leak data.
    as_of = today
    fcf_ttm, latest_period = finstack_ttm_fcf(con, symbol, as_of=as_of)
    if fcf_ttm is not None:
        # Finstack/Yahoo is raw INR while the ET proxy and this column's historical contract
        # are INR crore. Normalise the amount before persistence; use raw INR for the yield.
        features["fcf_ttm_approx"] = round(fcf_ttm / INR_PER_CRORE, 2)
        features["fcf_positive"] = 1 if fcf_ttm > 0 else 0
        features["fcf_yield_approx"] = (
            round(fcf_ttm / market_cap * 100, 4) if market_cap and market_cap > 0 else None
        )
        features["fcf_basis"] = FCF_BASIS_CAPEX
        features["fcf_ttm_as_of"] = latest_period
    else:
        # Honest no-data: leave the proxy labelled as a proxy rather than silently
        # presenting CFO+CFI as free cash flow. Both keys are always present so a
        # reader never has to distinguish "no capex basis" from "column absent".
        features["fcf_ttm_as_of"] = None
        features["fcf_basis"] = FCF_BASIS_PROXY if features.get("fcf_ttm_approx") is not None else None

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
    parser.add_argument("--force", action="store_true", default=False,
                        help="Force re-fetch all symbols even if fresh within last 20 days")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[FinancialRatios] No stocks with a companyid found.")
        con.close()
        return

    # Smart 20-day cadence check: this job runs WEEKLY (trendlyne-midweek-batch), but FCF
    # yield / interest coverage are earnings-driven and only move meaningfully on quarterly
    # results -- a 20-day window (shorter than mf_stock_holdings_fetcher.py's 25-day monthly
    # window, since this job's own cadence is weekly not monthly) still lets every symbol
    # refresh at least monthly while skipping ~3 of every 4 weekly passes for a symbol whose
    # ratios can't have changed.
    if not args.force and not args.symbol:
        from fetch_utils import filter_stale_symbols
        fresh_cutoff = (date.today() - timedelta(days=20)).isoformat()
        stale_stocks = filter_stale_symbols(con, stocks, "tl_financial_quality",
                                            date_col="fetched_at", as_of_date=fresh_cutoff)
        skipped = len(stocks) - len(stale_stocks)
        if skipped > 0:
            print(f"[FinancialRatios] Smart cadence skip: {skipped}/{len(stocks)} symbols already fresh within last 20 days. Processing {len(stale_stocks)} remaining.")
            stocks = stale_stocks

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
    tracker = FetchTracker(
        "financial_ratios_fetcher",
        fail_threshold=0.15,
        min_total_for_threshold=10,
        abort_after_consecutive_fails=20,
    )

    for i, (symbol, company_id) in enumerate(stocks, 1):
        try:
            features = process_stock(symbol, company_id, today, session, con)
            ok += 1
            tracker.record(symbol, ok=True)

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
            tracker.record(symbol, ok=False)
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}", file=sys.stderr)

    fcf_pct = round(fcf_positive_count / ok * 100) if ok else 0
    print(
        f"[FinancialRatios] Done. {ok} stocks. "
        f"FCF positive: {fcf_pct}%. "
        f"Interest coverage distress (<{DEBT_COVERAGE_RISK_THRESHOLD}x): {distress_count} stocks."
    )
    con.close()
    tracker.finish()


if __name__ == "__main__":
    main()

from pydantic import BaseModel
