"""
Insider Features Engine
========================
Computes rolling 90-day net insider activity per symbol from insider_trades and
writes insider_buy_pct_90d to the most-recent technical_signals row per symbol.

insider_buy_pct_90d in [0, 1]:
  > 0.5  net buying  (promoters/directors accumulating — strong India-specific signal)
  < 0.5  net selling (distribution)
  = 0.5  no activity (neutral default — stocks not in 150-stock MC batch)

Run: python insider_features.py
"""

import sys
import os
import datetime

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from db_compat import connect, read_df, executemany

WINDOW_DAYS = 90
BUY_TYPES   = {'BUY', 'ACQUISITION', 'PURCHASE', 'ACQUIRE'}
SELL_TYPES  = {'SELL', 'DISPOSAL', 'SALE'}


def compute_insider_features(cutoff_date: str) -> pd.DataFrame:
    """
    Returns DataFrame(symbol, insider_buy_pct_90d) for symbols with insider
    activity in the 90-day window ending at cutoff_date (YYYY-MM-DD, inclusive).
    """
    window_start = (
        datetime.date.fromisoformat(cutoff_date) - datetime.timedelta(days=WINDOW_DAYS)
    ).isoformat()

    df = read_df(
        "SELECT symbol, typeOfTransaction, quantity FROM insider_trades "
        "WHERE date >= ? AND date <= ?",
        (window_start, cutoff_date),
    )
    if df.empty:
        return pd.DataFrame(columns=['symbol', 'insider_buy_pct_90d'])

    df['typeOfTransaction'] = df['typeOfTransaction'].str.upper().str.strip()
    df['quantity'] = pd.to_numeric(df['quantity'], errors='coerce').fillna(0.0).clip(lower=0)

    df['buy_qty']  = np.where(df['typeOfTransaction'].isin(BUY_TYPES),  df['quantity'], 0.0)
    df['sell_qty'] = np.where(df['typeOfTransaction'].isin(SELL_TYPES), df['quantity'], 0.0)

    agg = df.groupby('symbol')[['buy_qty', 'sell_qty']].sum().reset_index()
    # +1 in denominator prevents 0/0 for rows with only unknown transaction types
    agg['insider_buy_pct_90d'] = (
        agg['buy_qty'] / (agg['buy_qty'] + agg['sell_qty'] + 1.0)
    ).clip(0.0, 1.0)

    return agg[['symbol', 'insider_buy_pct_90d']]


def run():
    conn = connect()
    try:
        today = datetime.date.today().isoformat()
        features = compute_insider_features(today)
        if features.empty:
            print("[Insider Features] No insider data in the last 90 days — skipping.")
            return

        rows = [
            (float(r['insider_buy_pct_90d']), r['symbol'], r['symbol'])
            for _, r in features.iterrows()
        ]
        executemany(
            "UPDATE technical_signals SET insider_buy_pct_90d = ? "
            "WHERE symbol = ? "
            "  AND date = (SELECT MAX(ts2.date) FROM technical_signals ts2 WHERE ts2.symbol = ?)",
            rows,
        )
        print(f"[Insider Features] Updated {len(rows)} symbols with insider_buy_pct_90d")
    finally:
        conn.close()


if __name__ == "__main__":
    run()
