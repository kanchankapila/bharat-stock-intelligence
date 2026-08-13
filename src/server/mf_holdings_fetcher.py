#!/usr/bin/env python3
"""Fetch mutual fund holding % per stock and store for ML features.

REWRITTEN 2026-08-13: the previous source (mfapps.indiatimes.com's MFPortfolioHolding.cms,
keyed by bse/nse code) is dead -- confirmed live, returns a clean nginx 404 for every symbol,
upstream retired. It had produced zero rows since the fetcher was added; every scheduled run
was ~200 requests that all 404'd. Replaced with ET's shareholding-pattern endpoint
(marketservices.indiatimes.com), keyed by the same ET `companyid` the ET_Stats fetchers already
use (scripts/stocklist.json via load_companyid_map()) -- confirmed live against RELIANCE/
HDFCBANK/BEL, real quarterly promoter/FII/DII/MF/pledge shareholding data.

  Source: https://marketservices.indiatimes.com/marketservices/shareholding?companyid={cid}
  summary.mf.percentage = MF holding % of the stock (as of the latest disclosed quarter)
  summary.mf.changeQoQ  = change vs the prior quarter

This endpoint has no per-fund count (no_of_funds) -- that metric is NOT reconstructed here.
mf_stock_holdings_fetcher.py (a separate, healthy fetcher/table) already covers fund-count and
share-level MF flow via technical_signals.mf_fund_count; duplicating it here would just be two
writers racing on the same column for no benefit. This fetcher's sole job is the ownership
LEVEL (mf_holding_pct) and its QoQ change (chg_vs_prev) -- the one metric nothing else on the
platform captures.

Writes to stock_mf_holdings (symbol, date, mf_holding_pct, chg_vs_prev).
Joins into technical_signals (mf_holding_pct, mf_chg_vs_prev), point-in-time gated: shareholding
disclosures are quarterly SEBI filings that lag the quarter-end by SHAREHOLDING_DISCLOSURE_LAG_DAYS
(30 = SEBI's 21-day mandatory filing deadline + ~9 days of ET aggregation lag; live-checked
2026-08-13 that the Jun-30 quarter's data was already available 44 days out, so 30 is
conservative without being needlessly so -- not independently verified against a real per-
company filing-date table the way MF_DISCLOSURE_LAG_DAYS=14 is in mf_stock_holdings_fetcher.py;
tighten if a real lag is ever measured).

Run weekly (shareholding patterns only change once a quarter; weekly is a generous crawl cadence).

Usage:
    python mf_holdings_fetcher.py
    python mf_holdings_fetcher.py --symbol RELIANCE
    python mf_holdings_fetcher.py --limit 50
"""
import argparse
import time
from datetime import date, timedelta

import requests

from db_compat import connect
from et_stats_client import HEADERS, load_companyid_map

RATE_LIMIT_SEC = 0.3
SHAREHOLDING_URL = "https://marketservices.indiatimes.com/marketservices/shareholding?companyid={cid}"
SHAREHOLDING_DISCLOSURE_LAG_DAYS = 30


def fetch_mf_holding(symbol: str, company_id: str, session: requests.Session) -> dict | None:
    try:
        r = session.get(SHAREHOLDING_URL.format(cid=company_id), timeout=10)
        if r.status_code != 200:
            return None
        data = r.json()
        mf = (data.get("summary") or {}).get("mf") or {}
        if not mf or mf.get("percentage") is None:
            return None
        # quarterDates[0] is {"date": <epoch-ms>, "dateStr": "30 Jun 2026"}, most-recent-first --
        # confirmed live 2026-08-13. Use the epoch field, not dateStr (locale-dependent format).
        quarter_dates = data.get("quarterDates") or []
        epoch_ms = quarter_dates[0].get("date") if quarter_dates else None
        as_of_date = date.fromtimestamp(epoch_ms / 1000).isoformat() if epoch_ms else None
        return {
            "symbol": symbol,
            "mf_holding_pct": round(float(mf["percentage"]), 4),
            "chg_vs_prev": round(float(mf["changeQoQ"]), 4) if mf.get("changeQoQ") is not None else None,
            "as_of_date": as_of_date,
        }
    except Exception as e:
        print(f"[MF] {symbol}: {e}")
        return None


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_mf_holdings (
            symbol         TEXT NOT NULL,
            date           TEXT NOT NULL,
            mf_holding_pct REAL,
            num_funds      INTEGER,
            chg_vs_prev    REAL,
            fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    # Columns on technical_signals
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN mf_holding_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN mf_fund_count INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN mf_chg_vs_prev REAL",
    ]:
        try:
            cur.execute(ddl)
        except Exception:
            pass
    con.commit()


def _floor(as_of_date: str | None, fallback: str) -> str:
    """Point-in-time floor: don't leak a shareholding figure onto rows dated before the
    disclosure was public. Same shape as mf_stock_holdings_fetcher.py's own _floor()."""
    try:
        d = date.fromisoformat(as_of_date[:10]) if as_of_date else None
    except (ValueError, TypeError):
        d = None
    if d:
        return (d + timedelta(days=SHAREHOLDING_DISCLOSURE_LAG_DAYS)).isoformat()
    return fallback


def upsert_holdings(rows: list[dict], today: str, con) -> None:
    cur = con.cursor()
    for r in rows:
        cur.execute("""
            INSERT INTO stock_mf_holdings (symbol, date, mf_holding_pct, chg_vs_prev)
            VALUES (?,?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                mf_holding_pct = excluded.mf_holding_pct,
                chg_vs_prev    = excluded.chg_vs_prev,
                fetched_at     = CURRENT_TIMESTAMP
        """, (r["symbol"], today, r["mf_holding_pct"], r.get("chg_vs_prev")))

        # Point-in-time: apply only to rows on/after the disclosure was public, NULL on older
        # rows -- across the symbol's whole history, not a single-date match (a bare
        # WHERE date = today silently touches 0 rows whenever this job runs on a non-trading
        # day with no matching technical_signals grid row yet; same bug class already fixed in
        # mf_stock_holdings_fetcher.py / financial_ratios_fetcher.py).
        floor = _floor(r.get("as_of_date"), fallback=today)
        cur.execute("""
            UPDATE technical_signals SET
                mf_holding_pct = CASE WHEN date >= ? THEN COALESCE(?, mf_holding_pct) ELSE NULL END,
                mf_chg_vs_prev = CASE WHEN date >= ? THEN COALESCE(?, mf_chg_vs_prev) ELSE NULL END
            WHERE symbol = ?
        """, (floor, r["mf_holding_pct"], floor, r.get("chg_vs_prev"), r["symbol"]))

    con.commit()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    ap.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    args = ap.parse_args()

    company_map = load_companyid_map()
    stocks = sorted(company_map.items())
    if args.symbol:
        stocks = [(s, c) for s, c in stocks if s == args.symbol.upper()]
    if args.limit:
        stocks = stocks[:args.limit]
    if not stocks:
        print("[MF] No stocks to fetch")
        return

    con = connect()
    ensure_schema(con)

    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()

    results = []
    for i, (sym, company_id) in enumerate(stocks, 1):
        result = fetch_mf_holding(sym, company_id, session)
        if result:
            results.append(result)
            print(f"[MF] {sym}: {result['mf_holding_pct']:.2f}% (chg {result.get('chg_vs_prev')})")
        else:
            print(f"[MF] {sym}: no data")
        if i % 100 == 0:
            print(f"[MF] Progress: {i}/{len(stocks)}")
        time.sleep(RATE_LIMIT_SEC)

    if results:
        upsert_holdings(results, today, con)
        print(f"[MF] Saved {len(results)}/{len(stocks)} holdings to stock_mf_holdings")
    else:
        print("[MF] No data fetched")

    con.close()


if __name__ == "__main__":
    main()
