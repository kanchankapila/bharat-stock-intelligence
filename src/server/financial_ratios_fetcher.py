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

Cadence: monthly (Balance/CashFlow/Ratio are annual-refresh ET_Stats data —
no value in fetching more often than once a month).

Writes:
  tl_financial_quality  (symbol, as_of_date) — raw + derived values
  technical_signals     — fcf_yield_approx, interest_coverage, fcf_positive,
                          debt_coverage_risk

Run:
  python financial_ratios_fetcher.py              # all stocks with a companyid
  python financial_ratios_fetcher.py --symbol BEL
  python financial_ratios_fetcher.py --limit 50
"""

import argparse
from datetime import date

import requests

from db_compat import connect
from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map

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
    con.commit()

    for ddl in [
        "ALTER TABLE tl_financial_quality ADD COLUMN fetched_at TEXT DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE technical_signals ADD COLUMN fcf_yield_approx   REAL",
        "ALTER TABLE technical_signals ADD COLUMN interest_coverage  REAL",
        "ALTER TABLE technical_signals ADD COLUMN fcf_positive       INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN debt_coverage_risk INTEGER",
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
    }


# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert_quality(symbol: str, today: str, row: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO tl_financial_quality
            (symbol, as_of_date, cfo_ttm, cfi_ttm, fcf_ttm_approx,
             interest_coverage, market_cap, fcf_yield_approx)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, as_of_date) DO UPDATE SET
            cfo_ttm            = excluded.cfo_ttm,
            cfi_ttm            = excluded.cfi_ttm,
            fcf_ttm_approx     = excluded.fcf_ttm_approx,
            interest_coverage  = excluded.interest_coverage,
            market_cap         = excluded.market_cap,
            fcf_yield_approx   = excluded.fcf_yield_approx,
            fetched_at         = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        row.get("cfo_ttm"), row.get("cfi_ttm"), row.get("fcf_ttm_approx"),
        row.get("interest_coverage"), row.get("market_cap"), row.get("fcf_yield_approx"),
    ))
    con.commit()


def update_technical_signals(symbol: str, features: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            fcf_yield_approx   = COALESCE(?, fcf_yield_approx),
            interest_coverage  = COALESCE(?, interest_coverage),
            fcf_positive       = COALESCE(?, fcf_positive),
            debt_coverage_risk = COALESCE(?, debt_coverage_risk)
        WHERE symbol = ?
    """, (
        features.get("fcf_yield_approx"),
        features.get("interest_coverage"),
        features.get("fcf_positive"),
        features.get("debt_coverage_risk"),
        symbol,
    ))
    con.commit()


def get_market_cap(symbol: str, con) -> float | None:
    cur = con.cursor()
    cur.execute("SELECT market_cap FROM stock_fundamentals WHERE symbol = ?", (symbol,))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else None


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, company_id: str, today: str,
                   session: requests.Session, con) -> dict:
    cashflow = fetch_et_stats(company_id, "CashFlow", session)
    ratio = fetch_et_stats(company_id, "Ratio", session)
    market_cap = get_market_cap(symbol, con)

    features = compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=market_cap)

    upsert_quality(symbol, today, features, con)
    update_technical_signals(symbol, features, con)
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
    today = date.today().isoformat()

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

            fcf_str = f"FCF yield≈{features['fcf_yield_approx']:.2f}%" if features.get("fcf_yield_approx") is not None else "FCF yield=n/a"
            cov_str = f"IC={features['interest_coverage']:.1f}x" if features.get("interest_coverage") is not None else "IC=n/a"
            flag = " [DISTRESS]" if features.get("debt_coverage_risk") else ""
            print(f"  [{i}/{len(stocks)}] {symbol}: {fcf_str} | {cov_str}{flag}")

        except Exception as e:
            try:
                con.rollback()
            except Exception:
                pass
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}")

    fcf_pct = round(fcf_positive_count / ok * 100) if ok else 0
    print(
        f"[FinancialRatios] Done. {ok} stocks. "
        f"FCF positive: {fcf_pct}%. "
        f"Interest coverage distress (<{DEBT_COVERAGE_RISK_THRESHOLD}x): {distress_count} stocks."
    )
    con.close()


if __name__ == "__main__":
    main()
