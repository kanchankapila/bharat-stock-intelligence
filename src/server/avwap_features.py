"""
Anchored VWAP Feature Engine
============================
Computes a 20-day rolling anchored VWAP for each symbol and writes
avwap_deviation_pct = (today_close − avwap) / avwap * 100
into technical_signals for today's date.

Anchored VWAP interpretation:
  > 0 : price above the rolling VWAP anchor → demand > supply, bullish
  < 0 : price below anchor → supply > demand, bearish
  abs > 5% : overextended (mean-reversion risk)

Run:  python avwap_features.py
      python avwap_features.py --date 2026-06-25
      python avwap_features.py --window 10   # shorter anchor window
"""
import polars as pl

import datetime
import argparse
import sys

import pandas as pd

from db_compat import connect
from as_of import logical_trading_date

AVWAP_WINDOW = 20  # trading days for the rolling anchor


def compute_avwap(conn, date_str: str, window: int = AVWAP_WINDOW) -> pd.DataFrame:
    """Return DataFrame(symbol, avwap_deviation_pct) for all symbols with
    sufficient OHLCV history ending on date_str."""
    rows = conn.execute("""
        SELECT symbol, date, high, low, close, volume
        FROM stock_ohlcv
        WHERE date <= ?
          AND COALESCE(is_suspect, 0) = 0
          AND close > 0 AND volume > 0
        ORDER BY symbol, date DESC
    """, (date_str,)).fetchall()

    if not rows:
        return pd.DataFrame(columns=['symbol', 'avwap_deviation_pct'])

    df = pd.DataFrame(rows, columns=['symbol', 'date', 'high', 'low', 'close', 'volume'])
    df = df.astype({'high': float, 'low': float, 'close': float, 'volume': float})

    results = []
    for sym, grp in df.groupby('symbol', sort=False):
        grp = grp.sort_values('date')
        if len(grp) < 2:
            continue
        # Take the last `window` bars (anchor = window days ago)
        tail = grp.tail(window)
        today_close = float(tail.iloc[-1]['close'])
        typical = (tail['high'] + tail['low'] + tail['close']) / 3.0
        avwap = (typical * tail['volume']).sum() / tail['volume'].sum()
        if avwap <= 0:
            continue
        dev_pct = round((today_close - avwap) / avwap * 100, 4)
        results.append({'symbol': sym, 'avwap_deviation_pct': dev_pct})

    return pd.DataFrame(results)


def write_features(conn, date_str: str, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    cur = conn.cursor()
    cur.executemany(
        "UPDATE technical_signals SET avwap_deviation_pct = ? WHERE symbol = ? AND date = ?",
        [(row['avwap_deviation_pct'], row['symbol'], date_str) for _, row in df.iterrows()],
    )
    conn.commit()
    return cur.rowcount


def run(date_str: str | None = None, window: int = AVWAP_WINDOW) -> None:
    if date_str is None:
        # logical_trading_date(), not date.today() (2026-08-01) -- this runs inside
        # ml-daily-ops with no --date arg, so this default is the live write target; the
        # step chain regularly finishes after midnight IST, which silently targeted a day
        # with no grid row yet. See as_of.logical_trading_date's docstring for the incident.
        date_str = logical_trading_date()
    conn = connect()
    try:
        df = compute_avwap(conn, date_str, window=window)
        n = write_features(conn, date_str, df)
        print(f"[AVWAP] {date_str}: computed {len(df)} symbols, updated {n} technical_signals rows "
              f"(window={window}d)")
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Anchored VWAP feature engine')
    parser.add_argument('--date',   default=None, help='Signal date (YYYY-MM-DD, default today)')
    parser.add_argument('--window', type=int, default=AVWAP_WINDOW, help='Anchor window in trading days')
    args = parser.parse_args()
    run(date_str=args.date, window=args.window)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
