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
from as_of import logical_trading_date

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

    # date_iso, NOT date. `insider_trades.date` is TEXT holding NSE's display format
    # ("05 Apr, 2022") on 46,194 of 46,198 rows, so `date >= '2026-05-01'` is a LEXICOGRAPHIC
    # string compare that matches almost nothing -- which is why this feature sat at 4 of
    # 2,187 rows (0.18%) despite 46k trades being available. The 2026-07-30 bias audit added
    # the parsed date_iso column for exactly this, but no consumer was ever switched over.
    df = read_df(
        'SELECT symbol, "typeOfTransaction", quantity FROM insider_trades '
        "WHERE date_iso >= ? AND date_iso <= ?",
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
        # logical_trading_date(), not date.today() -- ml-daily-ops's step chain now regularly
        # crosses midnight IST, and a raw date.today() write-target silently matched 0 rows
        # every time that happened (found 2026-08-01: 2026-07-31's row was still 4/2187
        # populated -- the exact pre-fix symptom -- because the run that should have written
        # it executed at 2026-08-01 01:23 IST, targeting a day with no grid row yet).
        today = logical_trading_date()
        features = compute_insider_features(today)
        if features.empty:
            print("[Insider Features] No insider data in the last 90 days — skipping.")
            return

        rows = [
            (float(r['insider_buy_pct_90d']), r['symbol'], today)
            for _, r in features.iterrows()
        ]
        # date = ? guard (2026-07-19) instead of MAX(date) -- see bse_event_classifier.py's
        # run_daily docstring for why matching the latest row isn't the same as matching today.
        executemany(
            "UPDATE technical_signals SET insider_buy_pct_90d = ? "
            "WHERE symbol = ? AND date = ?",
            rows,
        )
        print(f"[Insider Features] Updated {len(rows)} symbols with insider_buy_pct_90d")
    finally:
        conn.close()


if __name__ == "__main__":
    run()
