#!/usr/bin/env python3
"""
Live Screener Outcome Resolver.
Resolves EOD outcomes (1d, 3d, 5d returns) for live_screener_appearances.
"""

import sys
import datetime
from db_compat import connect

NIFTY_SYMBOL = "NIFTY50"


def _price_n_days_after(conn, symbol: str, start_date: str, n: int):
    rows = conn.execute(
        "SELECT close FROM stock_ohlcv WHERE symbol = ? AND date > ? ORDER BY date ASC LIMIT ?",
        (symbol, start_date, n + 5)
    ).fetchall()
    if len(rows) < n:
        return None
    return rows[n - 1][0]


def _price_on_or_after(conn, symbol: str, date: str):
    row = conn.execute(
        "SELECT close FROM stock_ohlcv WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT 1",
        (symbol, date)
    ).fetchone()
    return row[0] if row else None


def _ret(entry, exit_p):
    if entry is None or exit_p is None or entry == 0:
        return None
    return round((exit_p - entry) / entry * 100, 4)


def resolve_outcomes(dry_run=False):
    conn = connect()
    try:
        # live_screener_runs uses created_at (not timestamp)
        pending = conn.execute("""
            SELECT a.id          AS app_id,
                   a.symbol,
                   a.filter_key,
                   a.price       AS entry_price,
                   r.created_at  AS run_ts
            FROM   live_screener_appearances a
            JOIN   live_screener_runs r ON a.run_id = r.id
            LEFT   JOIN live_screener_outcomes o ON a.id = o.appearance_id
            WHERE  o.appearance_id IS NULL OR o.return_5d IS NULL
        """).fetchall()

        if not pending:
            print("[LiveScreenerResolver] No pending appearances to resolve.")
            return

        print(f"[LiveScreenerResolver] Resolving {len(pending)} pending appearances...")
        resolved = 0

        for row in pending:
            app_id     = row[0]
            symbol     = row[1]
            filter_key = row[2]
            entry_price = row[3]
            run_ts     = str(row[4])[:10]    # YYYY-MM-DD

            entry_close = _price_on_or_after(conn, symbol, run_ts)
            if entry_close is None:
                entry_close = entry_price      # use live price as fallback

            c1  = _price_n_days_after(conn, symbol, run_ts, 1)
            c3  = _price_n_days_after(conn, symbol, run_ts, 3)
            c5  = _price_n_days_after(conn, symbol, run_ts, 5)

            r1  = _ret(entry_close, c1)
            r3  = _ret(entry_close, c3)
            r5  = _ret(entry_close, c5)

            if r1 is None and r3 is None and r5 is None:
                continue

            # compute alpha_3d vs Nifty50
            n3   = _price_n_days_after(conn, NIFTY_SYMBOL, run_ts, 3)
            n_e  = _price_on_or_after(conn, NIFTY_SYMBOL, run_ts)
            alpha_3d = None
            if r3 is not None and n_e and n3:
                nifty_r3 = _ret(n_e, n3)
                alpha_3d = round(r3 - nifty_r3, 4) if nifty_r3 is not None else None

            if dry_run:
                print(f"  [DRY] {app_id} {symbol}: 1d={r1}% 3d={r3}% 5d={r5}% alpha3d={alpha_3d}%")
            else:
                conn.execute("""
                    INSERT INTO live_screener_outcomes
                        (appearance_id, symbol, filter_key, appeared_at,
                         entry_price, return_1d, return_3d, return_5d)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(appearance_id) DO UPDATE SET
                        return_1d = excluded.return_1d,
                        return_3d = excluded.return_3d,
                        return_5d = excluded.return_5d
                """, (app_id, symbol, filter_key, run_ts,
                      entry_price, r1, r3, r5))
            resolved += 1

        if not dry_run:
            conn.commit()
            print(f"[LiveScreenerResolver] Resolved {resolved} outcomes.")
        else:
            print(f"[LiveScreenerResolver] Dry-run: {resolved} would be resolved.")

    except Exception as e:
        print(f"[LiveScreenerResolver] Error: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    resolve_outcomes("--dry-run" in sys.argv)
