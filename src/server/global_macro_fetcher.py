#!/usr/bin/env python3
"""Fetch global macro indicators via yfinance and persist to macro_asset_prices table."""

import sys
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import yfinance as yf
import pandas as pd

DB_PATH = Path(__file__).parent.parent.parent / "stock_intelligence.db"

TICKERS = {
    "^TNX":      "US10Y",
    "DX-Y.NYB":  "DXY",
    "CL=F":      "CRUDE",
    "GC=F":      "GOLD",
    "^GSPC":     "SP500",
    "^NSEBANK":  "NSEBANK",
}

def fetch_macro(days: int = 30) -> None:
    end = datetime.today()
    start = end - timedelta(days=days + 10)  # buffer for weekends

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    for ticker, label in TICKERS.items():
        try:
            df = yf.download(ticker, start=start.strftime("%Y-%m-%d"),
                             end=end.strftime("%Y-%m-%d"), progress=False, auto_adjust=True)
            if df.empty:
                print(f"[MACRO] No data for {ticker}")
                continue

            df = df[["Close"]].copy()
            df.index = pd.to_datetime(df.index)
            df["ret_1d"] = df["Close"].pct_change(1)
            df["ret_5d"] = df["Close"].pct_change(5)

            rows = []
            for date, row in df.iterrows():
                rows.append((
                    date.strftime("%Y-%m-%d"),
                    label,
                    float(row["Close"]) if pd.notna(row["Close"]) else None,
                    float(row["ret_1d"]) if pd.notna(row["ret_1d"]) else None,
                    float(row["ret_5d"]) if pd.notna(row["ret_5d"]) else None,
                    datetime.now().isoformat(),
                ))

            cur.executemany(
                """INSERT OR REPLACE INTO macro_asset_prices
                   (date, symbol, close, ret_1d, ret_5d, fetched_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                rows,
            )
            con.commit()
            print(f"[MACRO] {label}: {len(rows)} rows upserted")
        except Exception as e:
            print(f"[MACRO] ERROR {ticker}: {e}")

    con.close()

if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    fetch_macro(days)
    print("[MACRO] Done")
