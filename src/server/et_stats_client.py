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

import json
import time
from pathlib import Path

import requests

BASE_URL = "https://etmarketsapis.indiatimes.com/ET_Stats/mobile"

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
            return None
        data = r.json()
        rows = data.get(result_key, {}).get("list", [])
        return rows if rows else None
    except Exception as e:
        print(f"  [ET_Stats {events}] error: {e}")
        return None
    finally:
        time.sleep(RATE_LIMIT_SEC)
