#!/usr/bin/env python3
"""
Working Capital Fetcher — Cash Conversion Cycle (annual cadence)
====================================================================
Rewritten 2026-07-04: the Trendlyne chart-data params this used to depend on
(TRADE_RECEIVABLE_Q, DEBTORS_Q, INVENTORIES_Q, TRADE_PAYABLE_Q, CREDITORS_Q,
REVENUE_Q, COGS_Q, RAW_MATERIAL_Q) are confirmed dead (live-tested, with and
without an authenticated Trendlyne session — Trendlyne retired this param
family, not a rate limit). Replaced with etmarketsapis.indiatimes.com's
ET_Stats mobile endpoint (see et_stats_client.py), keyed by ET `companyid`
(from scripts/stocklist.json) instead of Trendlyne's `tlid`.

Cadence change: receivables/inventory/payables only exist at ANNUAL
granularity in ET_Stats' Balance event — this matches Trendlyne's own true
ceiling too, since Indian-listed companies only file balance sheets
annually, not quarterly (only P&L is quarterly). This was always going to be
annual-cadence data; the old quarterly framing was never achievable. Revenue
and a COGS proxy for each fiscal year come from summing the 4 Quarterly
P&L rows (totalIncome, totalExpenses) whose yearEnding falls in that year.

Metrics (per fiscal year):
  Receivables days = (Trade Receivables / FY Revenue) × 365
  Inventory days   = (Inventory / FY COGS-proxy) × 365
  Payables days    = (Trade Payables / FY COGS-proxy) × 365
  CCC              = Receivables days + Inventory days - Payables days

Writes:
  working_capital_history  (symbol, fiscal_year) — per-year computed values
  technical_signals        — receivables_days_ttm, ccc_ttm, ccc_trend,
                             wc_deteriorating, wc_improving
  (column names kept as *_ttm for compatibility with existing consumers —
  "ttm" here means "most recent fiscal year", not a rolling 12 months.)

Cadence: monthly (annual-refresh data — no value fetching more often).

Run:
  python working_capital_fetcher.py              # all stocks with a companyid
  python working_capital_fetcher.py --symbol BEL
  python working_capital_fetcher.py --limit 50
"""

import argparse
from datetime import date, timedelta

import requests

from db_compat import connect
from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map

DETERIORATING_THRESHOLD_DAYS = 5
IMPROVING_THRESHOLD_DAYS = -5


# ── Schema ──────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS working_capital_history (
            symbol           TEXT NOT NULL,
            fiscal_year      TEXT NOT NULL,
            receivables_days REAL,
            inventory_days   REAL,
            payables_days    REAL,
            ccc              REAL,
            revenue_fy       REAL,
            cogs_proxy_fy    REAL,
            fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, fiscal_year)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_wch_sym
        ON working_capital_history(symbol, fiscal_year DESC)
    """)
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN receivables_days_ttm REAL",
        "ALTER TABLE technical_signals ADD COLUMN ccc_ttm              REAL",
        "ALTER TABLE technical_signals ADD COLUMN ccc_trend            REAL",
        "ALTER TABLE technical_signals ADD COLUMN wc_deteriorating     INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN wc_improving         INTEGER DEFAULT 0",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Pure computation (fully unit-testable, no network/DB) ───────────────────────

def _parse_yearending(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def compute_ccc(balance: list[dict] | None, quarterly: list[dict] | None) -> list[dict]:
    """balance: ET_Stats Balance.list (annual, most-recent-first).
    quarterly: ET_Stats Quarterly.list (quarterly, most-recent-first, 8 back).
    Returns one row per fiscal year that has both a balance-sheet snapshot
    and exactly 4 matching quarterly P&L rows, most-recent fiscal year first.

    A quarterly row belongs to a balance-sheet fiscal year if its yearEnding
    falls in the 12 months up to and including the balance sheet's own
    yearEnding — a plain "same calendar year" string match is wrong here
    because India's fiscal year runs Apr-Mar, so FY26's quarters carry
    yearEnding dates in both 2025 (Jun/Sep/Dec) and 2026 (Mar).
    """
    if not balance or not quarterly:
        return []

    results = []
    for b in balance:
        fy_end = _parse_yearending(b.get("yearEnding"))
        if fy_end is None:
            continue
        fy_start = fy_end.replace(year=fy_end.year - 1) + timedelta(days=1)

        year_quarters = [
            q for q in quarterly
            if (q_end := _parse_yearending(q.get("yearEnding"))) is not None and fy_start <= q_end <= fy_end
        ]
        if len(year_quarters) < 4:
            continue

        revenue_fy = sum(float(q.get("totalIncome") or 0) for q in year_quarters[:4])
        cogs_fy = sum(float(q.get("totalExpenses") or 0) for q in year_quarters[:4])

        if revenue_fy == 0:
            continue

        receivables = b.get("tradeReceivables")
        inventories = b.get("inventories")
        payables = b.get("tradePayables")

        if receivables is None:
            continue

        receivables_days = round(float(receivables) / revenue_fy * 365, 2)
        inventory_days = round(float(inventories) / cogs_fy * 365, 2) if inventories is not None and cogs_fy else None
        payables_days = round(float(payables) / cogs_fy * 365, 2) if payables is not None and cogs_fy else None
        ccc = round(receivables_days + inventory_days - payables_days, 2) if inventory_days is not None and payables_days is not None else None

        results.append({
            "fiscal_year": b.get("yearEnding"),
            "receivables_days": receivables_days,
            "inventory_days": inventory_days,
            "payables_days": payables_days,
            "ccc": ccc,
            "revenue_fy": revenue_fy,
            "cogs_proxy_fy": cogs_fy,
        })

    return results


# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert_wc_history(symbol: str, rows: list[dict], con) -> None:
    cur = con.cursor()
    for row in rows:
        cur.execute("""
            INSERT INTO working_capital_history
                (symbol, fiscal_year, receivables_days, inventory_days,
                 payables_days, ccc, revenue_fy, cogs_proxy_fy)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
                receivables_days = excluded.receivables_days,
                inventory_days   = excluded.inventory_days,
                payables_days    = excluded.payables_days,
                ccc              = excluded.ccc,
                revenue_fy       = excluded.revenue_fy,
                cogs_proxy_fy    = excluded.cogs_proxy_fy,
                fetched_at       = CURRENT_TIMESTAMP
        """, (
            symbol, row["fiscal_year"], row["receivables_days"], row["inventory_days"],
            row["payables_days"], row["ccc"], row["revenue_fy"], row["cogs_proxy_fy"],
        ))
    con.commit()


def update_technical_signals(symbol: str, features: dict, con) -> None:
    if not features:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            receivables_days_ttm = COALESCE(?, receivables_days_ttm),
            ccc_ttm              = COALESCE(?, ccc_ttm),
            ccc_trend            = COALESCE(?, ccc_trend),
            wc_deteriorating     = COALESCE(?, wc_deteriorating),
            wc_improving         = COALESCE(?, wc_improving)
        WHERE symbol = ?
    """, (
        features.get("receivables_days_ttm"),
        features.get("ccc_ttm"),
        features.get("ccc_trend"),
        features.get("wc_deteriorating"),
        features.get("wc_improving"),
        symbol,
    ))
    con.commit()


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, company_id: str, session: requests.Session, con) -> dict:
    balance = fetch_et_stats(company_id, "Balance", session)
    quarterly = fetch_et_stats(company_id, "Quarterly", session)

    ccc_rows = compute_ccc(balance, quarterly)
    if not ccc_rows:
        return {}

    upsert_wc_history(symbol, ccc_rows, con)

    latest = ccc_rows[0]
    prior = ccc_rows[1] if len(ccc_rows) > 1 else None

    ccc_trend = round(latest["ccc"] - prior["ccc"], 2) if latest.get("ccc") is not None and prior and prior.get("ccc") is not None else None
    wc_deteriorating = 1 if (ccc_trend is not None and ccc_trend > DETERIORATING_THRESHOLD_DAYS) else 0
    wc_improving = 1 if (ccc_trend is not None and ccc_trend < IMPROVING_THRESHOLD_DAYS) else 0

    features = {
        "receivables_days_ttm": latest.get("receivables_days"),
        "ccc_ttm": latest.get("ccc"),
        "ccc_trend": ccc_trend,
        "wc_deteriorating": wc_deteriorating,
        "wc_improving": wc_improving,
    }
    update_technical_signals(symbol, features, con)
    return features


# ── Stock list ────────────────────────────────────────────────────────────────────

def load_stocks(symbol_filter: str | None, limit: int | None) -> list[tuple[str, str]]:
    company_map = load_companyid_map()
    rows = sorted(company_map.items())
    if symbol_filter:
        rows = [(s, c) for s, c in rows if s == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Cash Conversion Cycle (annual) from ET_Stats")
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[WorkingCapital] No stocks with a companyid found.")
        con.close()
        return

    print(f"[WorkingCapital] Processing {len(stocks)} stocks — cash conversion cycle (annual)…")
    session = requests.Session()
    session.headers.update(HEADERS)

    ok = 0
    ccc_sum = 0.0
    ccc_count = 0
    deteriorating = 0
    improving = 0

    for i, (symbol, company_id) in enumerate(stocks, 1):
        try:
            features = process_stock(symbol, company_id, session, con)
            if not features:
                print(f"  [{i}/{len(stocks)}] {symbol}: no data")
                continue

            ok += 1
            ccc = features.get("ccc_ttm")
            trend = features.get("ccc_trend")

            if ccc is not None:
                ccc_sum += ccc
                ccc_count += 1
            if features.get("wc_deteriorating"):
                deteriorating += 1
            if features.get("wc_improving"):
                improving += 1

            ccc_str = f"CCC={ccc:.1f}d" if ccc is not None else "CCC=n/a"
            trend_str = f"trend={trend:+.1f}d" if trend is not None else "trend=n/a"
            flag = " [DETERIORATING]" if features.get("wc_deteriorating") else (" [IMPROVING]" if features.get("wc_improving") else "")
            print(f"  [{i}/{len(stocks)}] {symbol}: {ccc_str} | {trend_str}{flag}")

        except Exception as e:
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}")

    ccc_avg = round(ccc_sum / ccc_count, 1) if ccc_count else 0
    print(
        f"[WorkingCapital] Done. {ok} stocks. "
        f"CCC avg: {ccc_avg} days. "
        f"Deteriorating (>{DETERIORATING_THRESHOLD_DAYS}d trend): {deteriorating} stocks. "
        f"Improving: {improving} stocks."
    )
    con.close()


if __name__ == "__main__":
    main()
