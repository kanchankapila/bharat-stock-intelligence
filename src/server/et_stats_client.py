#!/usr/bin/env python3
"""
ET_Stats mobile-endpoint client — shared by financial_ratios_fetcher.py and
working_capital_fetcher.py.

Replaces the Trendlyne chart-data params both scripts used to depend on
(CFO_Q, CAPEX_Q, EBIT_Q, INT_EXP_Q, TRADE_RECEIVABLE_Q, DEBTORS_Q,
INVENTORIES_Q, TRADE_PAYABLE_Q, CREDITORS_Q, REVENUE_Q, COGS_Q,
RAW_MATERIAL_Q) — confirmed dead via live testing on 2026-07-04, with and
without an authenticated Trendlyne session (every call returns HTTP 200,
head.status="0", eodData: [] — Trendlyne retired this parameter family,
this is not a rate limit).

Endpoint: https://etmarketsapis.indiatimes.com/ET_Stats/mobile
  ?companyId={id}&events={Balance|CashFlow|Quarterly|Ratio}&last={n}&bType=all

  events=Balance    -> annual balance sheet, 5 years back
                       (inventories, tradeReceivables, tradePayables, ...)
  events=CashFlow   -> annual cash flow, 5 years back
                       (netCashFlowFromOperatingActivities, netCashUsedInInvestingActivities)
  events=Quarterly  -> quarterly P&L, 8 quarters back
                       (totalIncome, totalExpenses, ebit, pat, ...)
  events=Ratio      -> annual ratios, 5 years back
                       (interestCoverage, currentRatio, inventoryTurnoverRatio, ...)

companyId is resolved via scripts/stocklist.json (symbol -> companyid), the
same 2,005-stock provider-ID export already used elsewhere in this project —
NOT via Trendlyne's tlid.
"""

import polars as pl
import json
import time
from datetime import date, timedelta
from pathlib import Path

import requests

BASE_URL = "https://etmarketsapis.indiatimes.com/ET_Stats/mobile"

# Indian issuers must file audited annual results within 60 days of the fiscal year-end
# (SEBI LODR Reg 33). We use 90 to stay safely on the late side: an annual figure is only
# treated as knowable ~90d after its yearEnding, so a freshly-reported value is never stamped
# onto technical_signals rows that predate its publication (which would leak the future into
# ml_ensemble/exit_policy training, whose feature join reads these columns at each signal_date).
PUBLICATION_LAG_DAYS = 90


def as_of_floor(year_ending: str | None, fallback: str | None = None) -> str:
    """Earliest technical_signals.date an annual figure with this fiscal-year-end may be stamped
    on = yearEnding + PUBLICATION_LAG_DAYS. Falls back to `fallback` (stamp current rows only)
    when the fiscal-year-end is unknown — never earlier, so it cannot introduce look-ahead.

    `fallback` should be the last completed trading session's date (MAX(date) FROM stock_ohlcv),
    NOT left to default to date.today(): both callers of this function run inside the Sunday
    ml-weekly-retrain / monthly-first-Sunday batches, non-trading days with no technical_signals
    row yet for date.today(). On the (rare) fallback path -- year_ending missing/unparseable --
    a bare date.today() floor would match zero existing rows, so COALESCE(?, col) never fires for
    the caller's UPDATE ... WHERE date >= floor branch and the value silently never lands, same
    failure mode found and fixed in trendlyne_fundamentals_fetcher.py / mf_holdings_fetcher.py.
    """
    try:
        d = date.fromisoformat(str(year_ending)[:10]) if year_ending else None
    except ValueError:
        d = None
    if d:
        return (d + timedelta(days=PUBLICATION_LAG_DAYS)).isoformat()
    return fallback if fallback else date.today().isoformat()

# HEADERS: exported for caller to apply to their own requests.Session once at creation time
# (e.g., session.headers.update(HEADERS)), then pass that session into fetch_et_stats().
# This pattern allows reusing one session across multiple calls. fetch_et_stats() itself
# does not apply headers — that is the caller's responsibility.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

RATE_LIMIT_SEC = 0.3

_RESULT_KEY = {
    "Balance": "resultBalanceSheet",
    "CashFlow": "resultCashFlowStatement",
    "Quarterly": "resultQuarterlyResult",
    "Ratio": "resultRatiosStatement",
}

_STOCKLIST_PATH = Path(__file__).resolve().parents[2] / "scripts" / "stocklist.json"
_symbol_to_companyid: dict[str, str] | None = None


def load_companyid_map() -> dict[str, str]:
    """symbol (uppercase) -> companyid, loaded once from scripts/stocklist.json."""
    global _symbol_to_companyid
    if _symbol_to_companyid is not None:
        return _symbol_to_companyid

    with open(_STOCKLIST_PATH, encoding="utf-8") as f:
        rows = json.load(f)

    _symbol_to_companyid = {
        row["symbol"].upper(): str(row["companyid"])
        for row in rows
        if row.get("symbol") and row.get("companyid")
    }
    return _symbol_to_companyid


def fetch_et_stats(
    company_id: str,
    events: str,
    session: requests.Session,
    last: int = 5,
) -> list[dict] | None:
    """Fetch one events= slice for a companyId. Returns the inner `list`
    (most-recent-first) or None on failure/empty response."""
    result_key = _RESULT_KEY[events]
    try:
        r = session.get(
            BASE_URL,
            params={"companyId": company_id, "events": events, "last": last, "bType": "all"},
            timeout=15,
        )
        if r.status_code != 200:
            print(f"  [ET_Stats {events}] companyId={company_id} HTTP {r.status_code}")
            return None
        data = r.json()
        rows = data.get(result_key, {}).get("list", [])
        return rows if rows else None
    except Exception as e:
        print(f"  [ET_Stats {events}] error: {e}")
        return None
    finally:
        time.sleep(RATE_LIMIT_SEC)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
