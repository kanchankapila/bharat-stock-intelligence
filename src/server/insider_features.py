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
NEUTRAL = 0.5
# SEBI PIT lets an insider disclose up to 2 trading days after the trade and insider_trades
# stores the trade date, not the disclosure date -- so a history series must not see a trade
# until it could have been public. 7 calendar days covers 2 sessions plus a long weekend.
DISCLOSURE_LAG_DAYS = 7

# Open-market trades only, matched on UPPER(TRIM()) of the vendor's real strings (note NSE's
# double space). ESOP/gift/pledge/inter-se/allotment carry no view on price. These sets used to
# be {'BUY','ACQUISITION','PURCHASE','ACQUIRE'} / {'SELL','DISPOSAL','SALE'} matched EXACTLY, so
# NSE's 'ACQUISITION -  MARKET PURCHASE' (18.7k rows) never counted (AF-20260913-03).
# insider_transactions_fetcher.py passes these straight into a SQL IN list.
BUY_TYPES   = {'BUY', 'MARKET PURCHASE', 'ACQUISITION -  MARKET PURCHASE', 'ACQUISITION -  MARKET'}
SELL_TYPES  = {'SELL', 'MARKET SALE', 'DISPOSAL -  MARKET SALE', 'DISPOSAL -  MARKET'}
# insider_trades holds ~8.5 copies of each trade (79,327 rows / 9,302 distinct).
TRADE_KEY = ('symbol', 'acquirerName', 'typeOfTransaction', 'quantity', 'date_iso')


def _classified(trades: pd.DataFrame) -> pd.DataFrame:
    t = trades.copy()
    t['typeOfTransaction'] = t['typeOfTransaction'].astype(str).str.upper().str.strip()
    t = t.drop_duplicates(subset=[c for c in TRADE_KEY if c in t.columns])
    qty = pd.to_numeric(t['quantity'], errors='coerce').fillna(0.0).clip(lower=0)
    t['buy_qty'] = np.where(t['typeOfTransaction'].isin(BUY_TYPES), qty, 0.0)
    t['sell_qty'] = np.where(t['typeOfTransaction'].isin(SELL_TYPES), qty, 0.0)
    return t


def _buy_pct(buy, sell):
    buy = np.asarray(buy, dtype=float)
    total = buy + np.asarray(sell, dtype=float)
    return np.where(total > 0, buy / np.where(total > 0, total, 1.0), NEUTRAL)


def insider_buy_pct_series(trades: pd.DataFrame, dates, lag_days: int = DISCLOSURE_LAG_DAYS,
                           window_days: int = WINDOW_DAYS) -> pd.Series:
    """Point-in-time insider_buy_pct_90d for each of `dates` from ONE symbol's trades.

    A trade counts from date_iso + lag_days for window_days calendar days. Dates with no
    open-market trade in the window read NEUTRAL, never 0 (0 means 'all selling')."""
    idx = pd.DatetimeIndex(pd.to_datetime(dates))
    if trades is None or trades.empty:
        return pd.Series(NEUTRAL, index=idx, dtype=float)
    t = _classified(trades)
    t = t[(t['buy_qty'] > 0) | (t['sell_qty'] > 0)]
    t = t[pd.to_datetime(t['date_iso'], errors='coerce').notna()]
    if t.empty or len(idx) == 0:
        return pd.Series(NEUTRAL, index=idx, dtype=float)
    avail = (pd.to_datetime(t['date_iso']) + pd.Timedelta(days=lag_days)).dt.normalize()
    daily = t.assign(avail=avail.values).groupby('avail')[['buy_qty', 'sell_qty']].sum()
    norm = idx.normalize()
    cal = pd.date_range(min(daily.index.min(), norm.min()), max(daily.index.max(), norm.max()), freq='D')
    roll = daily.reindex(cal, fill_value=0.0).rolling(window_days, min_periods=1).sum().reindex(norm)
    return pd.Series(_buy_pct(roll['buy_qty'].values, roll['sell_qty'].values), index=idx)


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
        'SELECT symbol, "acquirerName", "typeOfTransaction", quantity, date_iso FROM insider_trades '
        "WHERE date_iso >= ? AND date_iso <= ?",
        (window_start, cutoff_date),
    )
    if df.empty:
        return pd.DataFrame(columns=['symbol', 'insider_buy_pct_90d'])

    agg = _classified(df).groupby('symbol')[['buy_qty', 'sell_qty']].sum().reset_index()
    agg['insider_buy_pct_90d'] = _buy_pct(agg['buy_qty'], agg['sell_qty'])

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
