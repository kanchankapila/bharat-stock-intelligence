#!/usr/bin/env python3
"""
Point-in-time-correct replacement for the price/volume-derived mc_* columns that
mc_pricefeed_fetcher.py was writing from a live-only snapshot with no date filter in its
UPDATE (WHERE symbol = ?, no date bound) -- every run smeared "today's" value across a
symbol's ENTIRE technical_signals history via COALESCE-fills-null-once-then-frozen-forever.
Confirmed 2026-07-19: mc_days_from_52wh (a day-counter that must increment daily) was
IDENTICAL across 8-16 different dates for every spot-checked symbol -- proof the value was
never really per-date. mc_ma30_dist was the #1 most important feature in ml_ensemble
(importance 214, clear of #2 at 158), so this was very likely functioning as a per-symbol
identity leak rather than genuine daily technical signal.

These are all standard price/volume calculations, fully reconstructable from stock_ohlcv
(which has real per-date history) -- no external API, no live-only dependency. This script
computes them correctly for every (symbol, date) in technical_signals and OVERWRITES
(not COALESCE) the existing columns, since the old values are known-corrupted, not just
possibly-stale.

Run:
    python mc_price_features_ohlcv.py                # all symbols/dates in technical_signals
    python mc_price_features_ohlcv.py --symbols BEL,INFY
"""
import polars as pl
import argparse
import sys

import numpy as np
import pandas as pd

from db_compat import connect, read_df, translate, use_postgres, get_engine

UPDATE_SQL = """
    UPDATE technical_signals SET
        mc_ma30_dist_pct     = ?,
        mc_ma50_dist_pct     = ?,
        mc_ma150_dist_pct    = ?,
        mc_ma200_dist_pct    = ?,
        mc_3d_return         = ?,
        mc_52w_high_dist_pct = ?,
        mc_52w_low_dist_pct  = ?,
        mc_days_from_52wh    = ?,
        mc_ytd_return        = ?,
        mc_vol_ratio         = ?
    WHERE symbol = ? AND date = ?
"""


def compute_features(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """ohlcv: columns [date, close, volume], sorted ascending by date, one symbol.
    Returns a frame indexed by date with the mc_* equivalents, using ONLY data up to and
    including that date (point-in-time correct by construction -- rolling/expanding windows
    never look forward)."""
    df = ohlcv.copy().reset_index(drop=True)
    close = df["close"]

    sma30  = close.rolling(30,  min_periods=20).mean()
    sma50  = close.rolling(50,  min_periods=35).mean()
    sma150 = close.rolling(150, min_periods=100).mean()
    sma200 = close.rolling(200, min_periods=150).mean()

    df["mc_ma30_dist_pct"]  = ((close - sma30)  / sma30  * 100).round(2)
    df["mc_ma50_dist_pct"]  = ((close - sma50)  / sma50  * 100).round(2)
    df["mc_ma150_dist_pct"] = ((close - sma150) / sma150 * 100).round(2)
    df["mc_ma200_dist_pct"] = ((close - sma200) / sma200 * 100).round(2)

    df["mc_3d_return"] = (close.pct_change(3) * 100).round(2)

    # Trailing 52-week (252 trading day) high/low and days since that high, computed with an
    # EXPANDING window for the first year (no false "no data" before a full year exists) then
    # a proper rolling 252-day window once enough history has accumulated.
    roll_max = close.rolling(252, min_periods=1).max()
    df["mc_52w_high_dist_pct"] = ((close - roll_max) / roll_max * 100).round(2)
    roll_min = close.rolling(252, min_periods=1).min()
    df["mc_52w_low_dist_pct"] = ((close - roll_min) / roll_min * 100).round(2)

    # Days since the trailing-252d high was made: walk the window, find the argmax offset.
    def days_since_high(window: np.ndarray) -> float:
        return float(len(window) - 1 - np.argmax(window))
    df["mc_days_from_52wh"] = close.rolling(252, min_periods=1).apply(days_since_high, raw=True)

    # YTD return: relative to the last close of the prior calendar year.
    df["_year"] = pd.to_datetime(df["date"]).dt.year
    year_start_close = df.groupby("_year")["close"].transform("first")
    df["mc_ytd_return"] = ((close - year_start_close) / year_start_close * 100).round(2)

    # Volume ratio: today's volume vs trailing 20-day average (excluding today).
    avg_vol20 = df["volume"].shift(1).rolling(20, min_periods=10).mean()
    df["mc_vol_ratio"] = (df["volume"] / avg_vol20).round(3)

    return df[["date", "mc_ma30_dist_pct", "mc_ma50_dist_pct", "mc_ma150_dist_pct",
               "mc_ma200_dist_pct", "mc_3d_return", "mc_52w_high_dist_pct",
               "mc_52w_low_dist_pct", "mc_days_from_52wh", "mc_ytd_return", "mc_vol_ratio"]]


def run(only: list[str] | None = None) -> dict:
    symbols_df = read_df(
        "SELECT DISTINCT symbol FROM technical_signals" +
        (f" WHERE symbol IN ({','.join(chr(39)+s+chr(39) for s in only)})" if only else "")
    )
    symbols = symbols_df["symbol"].tolist()
    print(f"[MCPriceFeatures] Recomputing point-in-time mc_* price features for {len(symbols)} symbols...")

    con = connect()
    updated, skipped = 0, 0
    for i, sym in enumerate(symbols):
        ts_dates = read_df(
            "SELECT date FROM technical_signals WHERE symbol = ? ORDER BY date", (sym,)
        )
        if ts_dates.empty:
            continue
        # Pull OHLCV from well before the earliest technical_signals date so rolling windows
        # (up to 252d) are warm, not padded with NaN at the start of this symbol's coverage.
        # Exclude bars ohlcv_quality.py has flagged (bad prints + extreme level shifts) so a
        # single bad tick doesn't corrupt every moving-average/return window it falls inside --
        # treated as a genuine gap (like a non-trading day), not silently included as real.
        ohlcv = read_df(
            "SELECT date, close, volume FROM stock_ohlcv WHERE symbol = ? AND is_suspect = 0 ORDER BY date",
            (sym,)
        )
        if len(ohlcv) < 20:
            skipped += 1
            continue
        ohlcv["date"] = pd.to_datetime(ohlcv["date"])
        feats = compute_features(ohlcv)
        feats["date"] = feats["date"].dt.strftime("%Y-%m-%d")
        feats_by_date = feats.set_index("date")

        rows = []
        for d in ts_dates["date"]:
            d_str = pd.to_datetime(d).strftime("%Y-%m-%d")
            if d_str not in feats_by_date.index:
                continue
            r = feats_by_date.loc[d_str]

            def _n(v):
                return None if pd.isna(v) else float(v)
            rows.append((
                _n(r["mc_ma30_dist_pct"]), _n(r["mc_ma50_dist_pct"]),
                _n(r["mc_ma150_dist_pct"]), _n(r["mc_ma200_dist_pct"]),
                _n(r["mc_3d_return"]), _n(r["mc_52w_high_dist_pct"]),
                _n(r["mc_52w_low_dist_pct"]),
                None if pd.isna(r["mc_days_from_52wh"]) else int(r["mc_days_from_52wh"]),
                _n(r["mc_ytd_return"]), _n(r["mc_vol_ratio"]),
                sym, d_str,
            ))
        if not rows:
            continue

        sql = translate(UPDATE_SQL)
        cur = con.cursor()
        if use_postgres():
            cur.executemany(sql, rows)
        else:
            cur.executemany(sql, rows)
        con.commit()
        updated += len(rows)
        if (i + 1) % 200 == 0:
            print(f"  [{i+1}/{len(symbols)}] {updated} rows written so far...")

    print(f"[MCPriceFeatures] Done. {updated} rows updated, {skipped} symbols skipped (insufficient OHLCV).")
    return {"updated": updated, "skipped": skipped}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Point-in-time mc_* price feature recompute from stock_ohlcv")
    parser.add_argument("--symbols", help="Comma-separated specific NSE symbols")
    args = parser.parse_args()
    only = [s.strip().upper() for s in args.symbols.split(",")] if args.symbols else None
    run(only)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
