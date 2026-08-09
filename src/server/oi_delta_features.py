"""
OI-Change Delta Feature Engine
================================
Computes day-over-day net open-interest change from stock_options_oi and
writes oi_net_change_pct into technical_signals for today's date.

  oi_net_change_pct = (total_oi_today - total_oi_prev) / total_oi_prev * 100

  > 0 : OI expanding → directional conviction in current move
  < 0 : OI contracting → position unwinding / lower conviction
  Combined with PCR: rising OI + PCR > 1 = put-heavy buildup (bearish institutional hedge)
                     rising OI + PCR < 1 = call-heavy buildup (bullish institutional positioning)

Depends on pcr_fetcher.py having run today (populates stock_options_oi).

Run:  python oi_delta_features.py
      python oi_delta_features.py --date 2026-06-25
"""

import datetime
import argparse

import pandas as pd

from db_compat import connect
from as_of import logical_trading_date


def compute_oi_delta(conn, date_str: str) -> pd.DataFrame:
    """Return DataFrame(symbol, oi_net_change_pct) for symbols in stock_options_oi
    that have both a today row and a previous row."""
    rows = conn.execute("""
        SELECT t.symbol,
               (t.total_call_oi + t.total_put_oi)           AS oi_today,
               (p.total_call_oi + p.total_put_oi)           AS oi_prev
        FROM stock_options_oi t
        JOIN stock_options_oi p
          ON p.symbol = t.symbol
         AND p.date = (
               SELECT MAX(date) FROM stock_options_oi s
               WHERE s.symbol = t.symbol AND s.date < ?
             )
        WHERE t.date = ?
          AND (t.total_call_oi + t.total_put_oi) > 0
          AND (p.total_call_oi + p.total_put_oi) > 0
    """, (date_str, date_str)).fetchall()

    if not rows:
        return pd.DataFrame(columns=['symbol', 'oi_net_change_pct'])

    results = []
    for sym, oi_today, oi_prev in rows:
        oi_today = float(oi_today)
        oi_prev  = float(oi_prev)
        pct = round((oi_today - oi_prev) / oi_prev * 100, 4)
        results.append({'symbol': sym, 'oi_net_change_pct': pct})

    return pd.DataFrame(results)


def write_features(conn, date_str: str, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    cur = conn.cursor()
    cur.executemany(
        "UPDATE technical_signals SET oi_net_change_pct = ? WHERE symbol = ? AND date = ?",
        [(row['oi_net_change_pct'], row['symbol'], date_str) for _, row in df.iterrows()],
    )
    conn.commit()
    return cur.rowcount


def run(date_str: str | None = None) -> None:
    if date_str is None:
        # logical_trading_date(), not date.today() (2026-08-01) -- this runs inside
        # ml-daily-ops with no --date arg, so this default is the live write target; the
        # step chain regularly finishes after midnight IST, which silently targeted a day
        # with no grid row yet. See as_of.logical_trading_date's docstring for the incident.
        date_str = logical_trading_date()
    conn = connect()
    try:
        df = compute_oi_delta(conn, date_str)
        n = write_features(conn, date_str, df)
        print(f"[OI-DELTA] {date_str}: computed {len(df)} symbols, "
              f"updated {n} technical_signals rows")
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='OI-change delta feature engine')
    parser.add_argument('--date', default=None, help='Signal date (YYYY-MM-DD, default today)')
    args = parser.parse_args()
    run(date_str=args.date)
