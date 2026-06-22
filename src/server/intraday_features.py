"""
Intraday Features Engine
=========================
Computes three microstructure features from 15-minute bars (intraday_ohlcv) for
today's session and writes them to technical_signals (most recent row per symbol).

Features:
  opening_range_break    1.0 = broke above first-30m high; -1.0 = below low; 0.0 = inside
  vwap_deviation_pct     (last_close - session_vwap) / session_vwap * 100
  first_hour_vol_share   first-hour volume / total session volume (0-1)

Run: python intraday_features.py
     python intraday_features.py --date 2026-06-21
"""

import sys
import os
import argparse
import datetime

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from db_compat import connect, read_df, executemany

_IST        = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
FIRST_BARS  = 2   # opening range = first 2 x 15m bars (30 minutes)
FIRST_HOUR  = 4   # first-hour volume window = first 4 x 15m bars


def compute_intraday_features(date_str: str) -> pd.DataFrame:
    """
    Returns DataFrame(symbol, opening_range_break, vwap_deviation_pct, first_hour_vol_share)
    for symbols with at least FIRST_BARS 15m bars on `date_str` (YYYY-MM-DD IST).
    """
    d = datetime.date.fromisoformat(date_str)
    # IST-aware ISO strings work on both SQLite (text compare) and PG (timestamptz compare)
    session_start = datetime.datetime(d.year, d.month, d.day, 9, 10, tzinfo=_IST).isoformat()
    session_end   = datetime.datetime(d.year, d.month, d.day, 15, 50, tzinfo=_IST).isoformat()

    df = read_df(
        "SELECT symbol, datetime, high, low, close, volume, vwap "
        "FROM intraday_ohlcv "
        "WHERE datetime >= ? AND datetime <= ? AND interval = '15m' "
        "ORDER BY symbol, datetime",
        (session_start, session_end),
    )
    if df.empty:
        return pd.DataFrame(columns=[
            'symbol', 'opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share',
        ])

    for col in ('volume', 'close', 'high', 'low', 'vwap'):
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df['volume'] = df['volume'].fillna(0.0)

    results = []
    for symbol, grp in df.groupby('symbol'):
        grp = grp.sort_values('datetime').reset_index(drop=True)
        if len(grp) < FIRST_BARS:
            continue

        # ── Opening Range Break ──────────────────────────────────────────────
        last_close = grp.iloc[-1]['close']

        if len(grp) >= FIRST_BARS:
            or_high = grp.iloc[:FIRST_BARS]['high'].max()
            or_low  = grp.iloc[:FIRST_BARS]['low'].min()

            if pd.isna(last_close) or pd.isna(or_high) or pd.isna(or_low):
                orb = 0.0
            elif last_close > or_high:
                orb = 1.0
            elif last_close < or_low:
                orb = -1.0
            else:
                orb = 0.0
        else:
            orb = 0.0

        # ── VWAP Deviation ──────────────────────────────────────────────────
        valid_vwap = grp['vwap'].dropna()
        if len(valid_vwap) > 0 and not pd.isna(last_close):
            session_vwap = float(valid_vwap.iloc[-1])
            vwap_dev = (last_close - session_vwap) / session_vwap * 100 if session_vwap != 0 else 0.0
        else:
            vwap_dev = 0.0

        # ── First-Hour Volume Share ─────────────────────────────────────────
        total_vol = float(grp['volume'].sum())
        first_vol = float(grp.iloc[:FIRST_HOUR]['volume'].sum())
        vol_share = (first_vol / total_vol) if total_vol > 0 else 0.5
        vol_share = min(max(vol_share, 0.0), 1.0)

        results.append({
            'symbol':               symbol,
            'opening_range_break':  orb,
            'vwap_deviation_pct':   round(float(vwap_dev), 4),
            'first_hour_vol_share': round(vol_share, 4),
        })

    return pd.DataFrame(results)


def run(date_str: str | None = None):
    if date_str is None:
        date_str = datetime.datetime.now(tz=_IST).date().isoformat()

    features = compute_intraday_features(date_str)
    if features.empty:
        print(f"[Intraday Features] No intraday data for {date_str} — skipping.")
        return

    rows = [
        (
            float(r['opening_range_break']),
            float(r['vwap_deviation_pct']),
            float(r['first_hour_vol_share']),
            r['symbol'],
            r['symbol'],
        )
        for _, r in features.iterrows()
    ]
    executemany(
        "UPDATE technical_signals "
        "SET opening_range_break = ?, vwap_deviation_pct = ?, first_hour_vol_share = ? "
        "WHERE symbol = ? "
        "  AND date = (SELECT MAX(ts2.date) FROM technical_signals ts2 WHERE ts2.symbol = ?)",
        rows,
    )
    print(f"[Intraday Features] Updated {len(rows)} symbols for session {date_str}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default=None, help='YYYY-MM-DD IST (default: today IST)')
    args = parser.parse_args()
    run(args.date)
