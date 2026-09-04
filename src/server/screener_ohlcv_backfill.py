#!/usr/bin/env python3
"""
screener_ohlcv_backfill.py
==========================
Fetches 2 years of historical OHLCV (Yahoo Finance) for all symbols that appear
in screener_appearances but are absent from stock_ohlcv.

This unlocks screener_performance.py phase_b, which computes return_5d / return_20d
and therefore win rates, alpha, bayesian_score, and tier upgrades for ~184k appearances.

Run once after a new screener sync that adds previously unseen symbols.
"""

import polars as pl
import pandas as pd
import datetime
import time
import sys

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance", file=sys.stderr)
    sys.exit(1)

from db_compat import connect

START_DATE = (datetime.date.today() - datetime.timedelta(days=730)).strftime("%Y-%m-%d")
BATCH_SIZE = 50          # yfinance can batch 50 tickers at once
SLEEP_BETWEEN_BATCHES = 2  # seconds — avoid rate limiting


def get_missing_symbols(conn) -> list[str]:
    """Return symbols in screener_appearances that have no stock_ohlcv data."""
    rows = conn.execute("""
        SELECT DISTINCT sa.symbol
        FROM screener_appearances sa
        WHERE NOT EXISTS (
            SELECT 1 FROM stock_ohlcv o WHERE o.symbol = sa.symbol
        )
        AND EXISTS (
            SELECT 1 FROM nse_stocks ns WHERE ns.symbol = sa.symbol
        )
        ORDER BY sa.symbol
    """).fetchall()
    return [r[0] for r in rows]


def _get_ticker_df(data: pd.DataFrame, ticker: str) -> pd.DataFrame | None:
    """Extract per-ticker DataFrame from a yfinance batch-download result regardless of MultiIndex orientation."""
    if not isinstance(data.columns, pd.MultiIndex):
        return data
    levels = [data.columns.get_level_values(i).unique().tolist() for i in range(data.columns.nlevels)]
    if ticker in levels[0]:
        return data[ticker]
    if ticker in levels[1]:
        return data.xs(ticker, axis=1, level=1)
    return None


def fetch_and_store(conn, symbols: list[str]) -> int:
    """Fetch OHLCV for a batch of NSE symbols from Yahoo Finance, store in stock_ohlcv."""
    tickers = [f"{s}.NS" for s in symbols]
    try:
        data = yf.download(
            tickers,
            start=START_DATE,
            auto_adjust=True,
            group_by="ticker",
            threads=True,
            progress=False,
        )
    except Exception as e:
        print(f"  [WARN] yfinance batch error: {e}", file=sys.stderr)
        return 0

    stored = 0
    records = []
    for sym, ticker in zip(symbols, tickers):
        try:
            df = _get_ticker_df(data, ticker) if len(symbols) > 1 else data
            if df is None or df.empty:
                continue

            if isinstance(df.columns, pd.MultiIndex):
                df = df.droplevel(level=-1, axis=1)

            if "Close" not in df.columns:
                continue

            df = df.dropna(subset=["Close"])
            for idx, row in df.iterrows():
                date_str = str(idx)[:10]
                records.append((
                    sym, date_str,
                    round(float(row["Open"]), 4) if "Open" in row else None,
                    round(float(row["High"]), 4) if "High" in row else None,
                    round(float(row["Low"]), 4)  if "Low"  in row else None,
                    round(float(row["Close"]), 4),
                    int(row["Volume"]) if "Volume" in row and row["Volume"] == row["Volume"] else None,
                    "split_dividend",
                ))
        except Exception as e:
            print(f"  [WARN] {sym}: {e}", file=sys.stderr)
            continue

    if records:
        try:
            conn.executemany("""
                INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, adjustment_basis)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (symbol, date) DO UPDATE SET
                  open=excluded.open, high=excluded.high, low=excluded.low,
                  close=excluded.close, volume=excluded.volume,
                  adjustment_basis=excluded.adjustment_basis
            """, records)
            conn.commit()
            stored = len(records)
        except Exception as ex:
            print(f"  [WARN] batch insert error: {ex}", file=sys.stderr)
            conn.rollback()

    return stored


def run():
    conn = connect()
    try:
        missing = get_missing_symbols(conn)
        print(f"[OHLCVBackfill] {len(missing)} symbols in screener_appearances missing from stock_ohlcv")

        if not missing:
            print("[OHLCVBackfill] Nothing to backfill.")
            return

        total_rows = 0
        for i in range(0, len(missing), BATCH_SIZE):
            batch = missing[i:i + BATCH_SIZE]
            rows = fetch_and_store(conn, batch)
            total_rows += rows
            pct = min(i + BATCH_SIZE, len(missing))
            print(f"  [{pct}/{len(missing)}] {rows} rows stored for batch {i//BATCH_SIZE + 1}")
            if i + BATCH_SIZE < len(missing):
                time.sleep(SLEEP_BETWEEN_BATCHES)

        print(f"[OHLCVBackfill] Done. {total_rows} OHLCV rows inserted for {len(missing)} symbols.")
        print(f"[OHLCVBackfill] Now run screener_performance.py to compute returns and bayesian scores.")
    finally:
        conn.close()


if __name__ == "__main__":
    run()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
