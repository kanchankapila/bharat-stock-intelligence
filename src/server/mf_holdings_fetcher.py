#!/usr/bin/env python3
"""Fetch mutual fund holding % per stock and store for ML features.

MF holding data is from ET Markets (mfapps.indiatimes.com) which aggregates
AMFI monthly disclosures. Fetches for all 180 mapped stocks.

Writes to stock_mf_holdings (symbol, date, mf_holding_pct, num_funds, chg_vs_prev).
Joins into technical_signals (mf_holding_pct, mf_fund_count).

Run weekly (not daily — AMFI disclosures are monthly, ETMarkets lags 2-3 days).
"""
import sys
import time
from datetime import date, timedelta

import requests
import pandas as pd

from db_compat import connect, use_postgres

RATE_LIMIT_SEC = 0.3

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://economictimes.indiatimes.com/",
}


def _load_stock_map() -> list[dict]:
    """Return [{symbol, bse_code, nse_code}] for all mapped stocks."""
    con = connect()
    ph = "%s" if use_postgres() else "?"
    # nse_stocks has symbol; stocklist.ts has companyid (ET company ID).
    # Fall back to using stocklist bse/nse codes via nse_stocks join.
    rows = []
    try:
        cur = con.cursor()
        cur.execute("""
            SELECT symbol, bse_code, nse_code
            FROM stock_mf_map
            WHERE bse_code IS NOT NULL OR nse_code IS NOT NULL
        """)
        rows = [{"symbol": r[0], "bse_code": r[1], "nse_code": r[2]} for r in cur.fetchall()]
    except Exception:
        # Clear aborted Postgres transaction state before executing fallback query
        try:
            con.rollback()
        except Exception:
            pass
        # stock_mf_map doesn't exist yet — use nse_stocks symbol as nse_code
        cur = con.cursor()
        cur.execute("SELECT symbol FROM nse_stocks LIMIT 200")
        rows = [{"symbol": r[0], "bse_code": None, "nse_code": r[0]} for r in cur.fetchall()]
    con.close()
    return rows


def fetch_mf_holding(symbol: str, bse_code: str | None, nse_code: str | None,
                     session: requests.Session) -> dict | None:
    bse = bse_code or ""
    nse = nse_code or symbol
    url = (
        f"https://mfapps.indiatimes.com/ET_Mutual_Funds/pages/mftools/MFPortfolioHolding.cms"
        f"?bsecode={bse}&nsecode={nse}&prime=N&flag=1"
    )
    try:
        r = session.get(url, timeout=10)
        if r.status_code != 200:
            return None
        data = r.json()
        # Response shape: {"data": {"holdingPct": "3.45", "noOfFunds": 12, ...}}
        # or {"portfolioHolding": {"holdingPercent": "3.45", "schemeCount": 12}}
        inner = (
            data.get("data") or
            data.get("portfolioHolding") or
            data.get("mfHolding") or
            {}
        )
        if not inner:
            return None

        holding_pct_raw = (
            inner.get("holdingPct") or
            inner.get("holdingPercent") or
            inner.get("mfHoldingPct") or
            inner.get("holdingPercentage") or
            None
        )
        num_funds_raw = (
            inner.get("noOfFunds") or
            inner.get("schemeCount") or
            inner.get("numberOfSchemes") or
            None
        )
        prev_pct_raw = (
            inner.get("prevHoldingPct") or
            inner.get("previousHoldingPercent") or
            None
        )

        if holding_pct_raw is None:
            return None

        holding_pct = float(str(holding_pct_raw).replace(",", "").replace("%", "") or 0)
        num_funds = int(num_funds_raw) if num_funds_raw is not None else None
        prev_pct = float(str(prev_pct_raw).replace(",", "").replace("%", "")) if prev_pct_raw else None
        chg = round(holding_pct - prev_pct, 4) if prev_pct is not None else None

        return {
            "symbol": symbol,
            "mf_holding_pct": round(holding_pct, 4),
            "num_funds": num_funds,
            "chg_vs_prev": chg,
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


def upsert_holdings(rows: list[dict], today: str, con) -> None:
    cur = con.cursor()
    for r in rows:
        cur.execute("""
            INSERT INTO stock_mf_holdings (symbol, date, mf_holding_pct, num_funds, chg_vs_prev)
            VALUES (?,?,?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                mf_holding_pct = excluded.mf_holding_pct,
                num_funds      = excluded.num_funds,
                chg_vs_prev    = excluded.chg_vs_prev,
                fetched_at     = CURRENT_TIMESTAMP
        """, (r["symbol"], today, r["mf_holding_pct"], r.get("num_funds"), r.get("chg_vs_prev")))

    # Back-fill today's technical_signals rows using the date column used by the
    # feature joiners in ml_ensemble/exit_policy. This keeps the write compatible with
    # both SQLite and Postgres through db_compat.
    for r in rows:
        cur.execute("""
            UPDATE technical_signals
            SET mf_holding_pct = ?,
                mf_fund_count  = ?,
                mf_chg_vs_prev = ?
            WHERE symbol = ? AND date = ?
        """, (r["mf_holding_pct"], r.get("num_funds"), r.get("chg_vs_prev"), r["symbol"], today))

    con.commit()


def main():
    stocks = _load_stock_map()
    if not stocks:
        print("[MF] No stocks to fetch")
        return

    con = connect()
    ensure_schema(con)

    session = requests.Session()
    session.headers.update(HEADERS)
    # Align to the last completed trading session (same date the grid-ensurer builds), NOT
    # date.today() -- this job runs in the Sunday ml-weekly-retrain batch, a non-trading day
    # with no technical_signals row yet. The UPDATE below is a plain "WHERE date = today" (no
    # ELSE-NULL branch), so on a day with no matching row it silently affects 0 rows -- no
    # error, no rows touched, mf_holding_pct/mf_chg_vs_prev permanently null. Same fix pattern
    # as mc_techscanner_fetcher.py / trendlyne_fundamentals_fetcher.py.
    latest_row = con.execute("SELECT MAX(date) AS d FROM stock_ohlcv").fetchone()
    today = str(latest_row["d"])[:10] if latest_row and latest_row["d"] else date.today().isoformat()

    results = []
    for i, stock in enumerate(stocks, 1):
        sym = stock["symbol"]
        result = fetch_mf_holding(sym, stock.get("bse_code"), stock.get("nse_code"), session)
        if result:
            results.append(result)
            print(f"[MF] {sym}: {result['mf_holding_pct']:.2f}% ({result.get('num_funds', '?')} funds)")
        else:
            print(f"[MF] {sym}: no data")
        if i % 10 == 0:
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
