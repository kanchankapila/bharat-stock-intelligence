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
from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map, as_of_floor

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
    }


# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert_quality(symbol: str, today: str, row: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO tl_financial_quality
            (symbol, as_of_date, cfo_ttm, cfi_ttm, fcf_ttm_approx,
             interest_coverage, market_cap, fcf_yield_approx,
             roce, roce_trend, quick_ratio, ev_ebitda, asset_turnover, cfo_growth)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, as_of_date) DO UPDATE SET
            cfo_ttm            = excluded.cfo_ttm,
            cfi_ttm            = excluded.cfi_ttm,
            fcf_ttm_approx     = excluded.fcf_ttm_approx,
            interest_coverage  = excluded.interest_coverage,
            market_cap         = excluded.market_cap,
            fcf_yield_approx   = excluded.fcf_yield_approx,
            roce               = excluded.roce,
            roce_trend         = excluded.roce_trend,
            quick_ratio        = excluded.quick_ratio,
            ev_ebitda          = excluded.ev_ebitda,
            asset_turnover     = excluded.asset_turnover,
            cfo_growth         = excluded.cfo_growth,
            fetched_at         = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        row.get("cfo_ttm"), row.get("cfi_ttm"), row.get("fcf_ttm_approx"),
        row.get("interest_coverage"), row.get("market_cap"), row.get("fcf_yield_approx"),
        row.get("roce"), row.get("roce_trend"), row.get("quick_ratio"),
        row.get("ev_ebitda"), row.get("asset_turnover"), row.get("cfo_growth"),
    ))
    con.commit()


def update_technical_signals(symbol: str, features: dict, con) -> None:
    # Point-in-time stamp: apply these annual figures only to rows on/after the results were
    # published (date >= floor), and NULL them on older rows. A plain `WHERE symbol = ?` smeared
    # the latest annual value across the symbol's whole history, leaking future fundamentals into
    # the per-signal-date feature join in ml_ensemble/exit_policy. The as-of trail lives in
    # tl_financial_quality; technical_signals only carries the value from its knowable date on.
    floor = as_of_floor(features.get("year_ending"))
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            fcf_yield_approx   = CASE WHEN date >= ? THEN COALESCE(?, fcf_yield_approx)   ELSE NULL END,
            interest_coverage  = CASE WHEN date >= ? THEN COALESCE(?, interest_coverage)  ELSE NULL END,
            fcf_positive       = CASE WHEN date >= ? THEN COALESCE(?, fcf_positive)       ELSE NULL END,
            debt_coverage_risk = CASE WHEN date >= ? THEN COALESCE(?, debt_coverage_risk) ELSE NULL END,
            roce               = CASE WHEN date >= ? THEN COALESCE(?, roce)               ELSE NULL END,
            roce_trend         = CASE WHEN date >= ? THEN COALESCE(?, roce_trend)         ELSE NULL END,
            quick_ratio        = CASE WHEN date >= ? THEN COALESCE(?, quick_ratio)        ELSE NULL END,
            ev_ebitda          = CASE WHEN date >= ? THEN COALESCE(?, ev_ebitda)          ELSE NULL END,
            asset_turnover     = CASE WHEN date >= ? THEN COALESCE(?, asset_turnover)     ELSE NULL END,
            cfo_growth         = CASE WHEN date >= ? THEN COALESCE(?, cfo_growth)         ELSE NULL END
        WHERE symbol = ?
    """, (
        floor, features.get("fcf_yield_approx"),
        floor, features.get("interest_coverage"),
        floor, features.get("fcf_positive"),
        floor, features.get("debt_coverage_risk"),
        floor, features.get("roce"),
        floor, features.get("roce_trend"),
        floor, features.get("quick_ratio"),
        floor, features.get("ev_ebitda"),
        floor, features.get("asset_turnover"),
        floor, features.get("cfo_growth"),
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
