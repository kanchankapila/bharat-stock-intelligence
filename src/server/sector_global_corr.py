#!/usr/bin/env python3
"""Compute rolling 21d correlation between each NSE sector and its global benchmark.

Reads:
  - stock_ohlcv (sector returns)
  - nse_stocks (sector labels)
  - macro_asset_prices (SP500, CRUDE, GOLD, DXY returns)

Writes sector_global_corr (date, sector, benchmark, corr_21d, corr_63d)
and joins into technical_signals (sector_global_corr_21d).

Run daily after global_macro_fetcher.py.
"""
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd

from db_compat import connect, read_df, use_postgres, safe_alter, try_advisory_lock, release_advisory_lock

SECTOR_BENCHMARK_MAP = {
    "Information Technology": "SP500",
    "Technology":             "SP500",
    "IT":                     "SP500",
    "Energy":                 "CRUDE",
    "Oil & Gas":              "CRUDE",
    "Metals & Mining":        "GOLD",
    "Materials":              "GOLD",
    "Banking":                "DXY",
    "Financial Services":     "DXY",
    "Financials":             "DXY",
    "Banks":                  "DXY",
    "FMCG":                   "SP500",
    "Consumer":               "SP500",
    "Pharma":                 "SP500",
    "Healthcare":             "SP500",
    "Auto":                   "SP500",
    "Industrials":            "SP500",
    "Realty":                 "SP500",
    "Telecom":                "SP500",
}

LOOKBACK = 90


def main(days: int = 7):
    if not try_advisory_lock("sector_global_corr"):
        print("[SectorCorr] Another run is already in progress — skipping.")
        return

    con = connect()
    cur = con.cursor()

    try:
        _run(con, cur, days)
    finally:
        con.close()
        release_advisory_lock("sector_global_corr")


def _run(con, cur, days: int):
    # Each ALTER runs in its own auto-committed statement (safe_alter uses a
    # fresh engine.begin() block on PG) so a "column already exists" no-op
    # can never poison the transaction `con`/`cur` use for the rest of this run.
    safe_alter(None, "ALTER TABLE technical_signals ADD COLUMN sector_global_corr_21d REAL")
    safe_alter(None, "ALTER TABLE technical_signals ADD COLUMN sector_benchmark TEXT")

    end_date = date.today()
    start_date = end_date - timedelta(days=LOOKBACK + days + 10)

    ns = read_df("SELECT symbol, sector FROM nse_stocks WHERE sector IS NOT NULL AND sector != ''")
    if ns.empty:
        print("[SectorCorr] No sector data in nse_stocks")
        return

    ohlcv = read_df(f"""
        SELECT o.symbol, o.date, o.close
        FROM stock_ohlcv o
        JOIN nse_stocks ns ON ns.symbol = o.symbol
        WHERE o.date >= '{start_date}'
        ORDER BY o.date
    """)
    if ohlcv.empty:
        print("[SectorCorr] No OHLCV data")
        return

    ohlcv["date"] = pd.to_datetime(ohlcv["date"])
    ohlcv = ohlcv.merge(ns[["symbol", "sector"]], on="symbol", how="left")

    pivot = ohlcv.pivot_table(index="date", columns="symbol", values="close")

    sectors = ohlcv["sector"].dropna().unique()
    sector_ret = {}
    for sector in sectors:
        syms = [s for s in (ns[ns["sector"] == sector]["symbol"].tolist()) if s in pivot.columns]
        if not syms:
            continue
        sector_ret[sector] = pivot[syms].mean(axis=1).pct_change()

    if not sector_ret:
        print("[SectorCorr] No sector returns computed")
        return

    sector_df = pd.DataFrame(sector_ret).dropna(how="all")

    macro = read_df(f"""
        SELECT date, symbol AS benchmark, ret_1d
        FROM macro_asset_prices
        WHERE date >= '{start_date}'
          AND symbol IN ('SP500', 'CRUDE', 'GOLD', 'DXY')
    """)
    if macro.empty:
        print("[SectorCorr] No macro data in macro_asset_prices — run global_macro_fetcher.py first")
        return

    macro["date"] = pd.to_datetime(macro["date"])
    macro_pivot = macro.pivot_table(index="date", columns="benchmark", values="ret_1d")

    rows = []
    for sector, benchmark in SECTOR_BENCHMARK_MAP.items():
        if sector not in sector_df.columns:
            continue
        if benchmark not in macro_pivot.columns:
            continue
        combined = pd.concat([sector_df[sector].rename("sector"), macro_pivot[benchmark].rename("bench")], axis=1, sort=False).dropna()
        if len(combined) < 21:
            continue
        corr_21 = combined["sector"].rolling(21).corr(combined["bench"])
        corr_63 = combined["sector"].rolling(63).corr(combined["bench"]) if len(combined) >= 63 else pd.Series(np.nan, index=combined.index)
        for dt in combined.index[-days:]:
            rows.append({
                "date": dt.date().isoformat(),
                "sector": sector,
                "benchmark": benchmark,
                "corr_21d": round(float(corr_21.get(dt, np.nan)), 4) if not np.isnan(corr_21.get(dt, np.nan)) else None,
                "corr_63d": round(float(corr_63.get(dt, np.nan)), 4) if pd.notna(corr_63.get(dt, np.nan)) else None,
            })

    if not rows:
        print("[SectorCorr] No correlation rows to write")
        return

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sector_global_corr (
            date      TEXT NOT NULL,
            sector    TEXT NOT NULL,
            benchmark TEXT NOT NULL,
            corr_21d  REAL,
            corr_63d  REAL,
            PRIMARY KEY (date, sector)
        )
    """)

    for r in rows:
        cur.execute("""
            INSERT INTO sector_global_corr (date, sector, benchmark, corr_21d, corr_63d)
            VALUES (?,?,?,?,?)
            ON CONFLICT(date, sector) DO UPDATE SET
                benchmark = excluded.benchmark,
                corr_21d  = excluded.corr_21d,
                corr_63d  = excluded.corr_63d
        """, (r["date"], r["sector"], r["benchmark"], r["corr_21d"], r["corr_63d"]))

    con.commit()

    today = date.today().isoformat()
    if use_postgres():
        cur.execute("""
            UPDATE technical_signals ts
            SET sector_global_corr_21d = sgc.corr_21d,
                sector_benchmark       = sgc.benchmark
            FROM sector_global_corr sgc
            JOIN nse_stocks ns ON ns.sector = sgc.sector
            WHERE ts.symbol = ns.symbol
              AND sgc.date = ?
              AND ts.date = ?
        """, (today, today))
    else:
        cur.execute("""
            UPDATE technical_signals
            SET sector_global_corr_21d = (
                SELECT sgc.corr_21d FROM sector_global_corr sgc
                JOIN nse_stocks ns ON ns.sector = sgc.sector
                WHERE sgc.date = ? AND ns.symbol = technical_signals.symbol
                LIMIT 1
            ),
            sector_benchmark = (
                SELECT sgc.benchmark FROM sector_global_corr sgc
                JOIN nse_stocks ns ON ns.sector = sgc.sector
                WHERE sgc.date = ? AND ns.symbol = technical_signals.symbol
                LIMIT 1
            )
            WHERE date = ?
        """, (today, today, today))

    con.commit()
    print(f"[SectorCorr] Wrote {len(rows)} sector-correlation rows, updated technical_signals")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=7)
    args = p.parse_args()
    main(args.days)
