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

import polars as pl
import sys
import os
import argparse
import datetime

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from db_compat import connect, read_df, executemany

_IST        = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
BAR_MINUTES = 15
# Windows are defined in MINUTES FROM THE SESSION OPEN and resolved against each bar's own
# timestamp -- never by row position. Both vendors append the current in-progress quote to the
# history array stamped at request time rather than on the bar grid (a real 09:30:00 bar plus a
# bogus 09:30:20 one, volume 0, open==high==low==close). Selecting positionally (the previous
# `grp.iloc[:2]` / `grp.iloc[:4]`) let those synthetic rows eat the window, so "first hour"
# routinely covered only 45 minutes: measured 2026-07-30, the stored first_hour_vol_share
# correlated just 0.642 with the same feature computed off clean grid bars (5.9% exact match,
# MAE 0.060 on a 0-1 feature, biased low at 0.197 vs 0.245). intraday_fetcher.py now drops
# off-grid bars at write time, but ~2M such rows already exist in the compressed hypertable and
# are not being backfilled out, so the read side has to defend itself too (_on_grid below).
OPENING_RANGE_MIN = 30   # opening range = first 30 minutes
FIRST_HOUR_MIN    = 60   # first-hour volume window
SESSION_OPEN      = datetime.time(9, 15)


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

    ts = pd.to_datetime(df['datetime'], utc=True, errors='coerce').dt.tz_convert(_IST)
    df = df.assign(_ts=ts).dropna(subset=['_ts'])
    # Drop off-grid synthetic quotes (see module constants) before any window is taken.
    df = df[(df['_ts'].dt.second == 0) & (df['_ts'].dt.minute % BAR_MINUTES == 0)]
    if df.empty:
        return pd.DataFrame(columns=[
            'symbol', 'opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share',
        ])
    open_ts = pd.Timestamp(datetime.datetime.combine(d, SESSION_OPEN), tz=_IST)
    df = df.assign(_min=(df['_ts'] - open_ts).dt.total_seconds() / 60.0)

    results = []
    for symbol, grp in df.groupby('symbol'):
        grp = grp.sort_values('_ts')
        opening = grp[grp['_min'] < OPENING_RANGE_MIN]
        if opening.empty:
            continue  # no session-open data -- an opening range can't be defined

        last_close = grp.iloc[-1]['close']

        # ── Opening Range Break ──────────────────────────────────────────────
        or_high = opening['high'].max()
        or_low  = opening['low'].min()
        if pd.isna(last_close) or pd.isna(or_high) or pd.isna(or_low):
            orb = 0.0
        elif last_close > or_high:
            orb = 1.0
        elif last_close < or_low:
            orb = -1.0
        else:
            orb = 0.0

        # ── VWAP Deviation ──────────────────────────────────────────────────
        # Prefer the stored session VWAP; fall back to computing it from the bars themselves
        # (cumulative typical-price * volume) when the column is NULL. intraday_ohlcv.vwap was
        # written as a literal NULL for every row until 2026-07-31, so without this fallback
        # the feature is a constant 0.0 -- populated-looking and information-free -- for every
        # symbol on every historical session.
        session_vwap = None
        stored = grp['vwap'].dropna()
        if len(stored):
            session_vwap = float(stored.iloc[-1])
        else:
            vol = grp['volume'].fillna(0.0)
            typ = (grp['high'] + grp['low'] + grp['close']) / 3.0
            mask = typ.notna() & (vol > 0)
            if mask.any() and vol[mask].sum() > 0:
                session_vwap = float((typ[mask] * vol[mask]).sum() / vol[mask].sum())
        if session_vwap and not pd.isna(last_close):
            vwap_dev = (last_close - session_vwap) / session_vwap * 100
        else:
            vwap_dev = 0.0

        # ── First-Hour Volume Share ─────────────────────────────────────────
        total_vol = float(grp['volume'].sum())
        first_vol = float(grp[grp['_min'] < FIRST_HOUR_MIN]['volume'].sum())
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


def backfill(start_date: str | None = None, end_date: str | None = None, dry_run: bool = False):
    """
    Backfill intraday features for all signal_outcomes dates that have intraday bar data.
    Uses a date-exact WHERE clause (not MAX) so historical technical_signals rows get the
    right session's features rather than today's.
    """
    from db_compat import connect, query_all
    conn = connect()

    # Dates to process: intersection of signal_outcomes dates and intraday_ohlcv dates
    cutoff_clause = ""
    params: list = []
    if start_date:
        cutoff_clause += " AND so.signal_date >= ?"
        params.append(start_date)
    if end_date:
        cutoff_clause += " AND so.signal_date <= ?"
        params.append(end_date)

    dates = conn.execute(f"""
        SELECT DISTINCT so.signal_date
        FROM signal_outcomes so
        WHERE EXISTS (
            SELECT 1 FROM intraday_ohlcv io
            WHERE io.datetime::date = so.signal_date::date
        )
        {cutoff_clause}
        ORDER BY so.signal_date
    """, tuple(params)).fetchall()

    if not dates:
        print("[Intraday Backfill] No overlapping dates between signal_outcomes and intraday_ohlcv.")
        conn.close()
        return

    date_strs = [str(r[0])[:10] for r in dates]
    print(f"[Intraday Backfill] Processing {len(date_strs)} dates: {date_strs[0]} to {date_strs[-1]}")

    total_updated = 0
    for date_str in date_strs:
        features = compute_intraday_features(date_str)
        if features.empty:
            print(f"  {date_str}: no bars — skip")
            continue

        rows = [
            (
                float(r['opening_range_break']),
                float(r['vwap_deviation_pct']),
                float(r['first_hour_vol_share']),
                r['symbol'],
                date_str,
            )
            for _, r in features.iterrows()
        ]
        if dry_run:
            print(f"  {date_str}: [DRY] would update {len(rows)} symbols")
            continue

        conn.executemany(
            "UPDATE technical_signals "
            "SET opening_range_break = ?, vwap_deviation_pct = ?, first_hour_vol_share = ? "
            "WHERE symbol = ? AND date::text = ?",
            rows,
        )
        conn.commit()
        total_updated += len(rows)
        print(f"  {date_str}: updated {len(rows)} symbols")

    conn.close()
    print(f"[Intraday Backfill] Done — {total_updated} rows updated across {len(date_strs)} dates.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default=None, help='YYYY-MM-DD IST (default: today IST)')
    parser.add_argument('--backfill', action='store_true', help='Backfill all signal_outcomes dates')
    parser.add_argument('--start', default=None, help='Backfill start date (YYYY-MM-DD)')
    parser.add_argument('--end',   default=None, help='Backfill end date (YYYY-MM-DD)')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if args.backfill:
        backfill(start_date=args.start, end_date=args.end, dry_run=args.dry_run)
    else:
        run(args.date)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
