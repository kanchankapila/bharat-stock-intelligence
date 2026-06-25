#!/usr/bin/env python3
"""
Live Screener Outcome Resolver.
Resolves EOD outcomes (1-day, 3-day, 5-day returns) for live screener appearances.
Uses the db_compat layer to support both SQLite and PostgreSQL.
"""

import sys
import datetime
from db_compat import connect, ConnWrapper

def get_trading_days_after(conn: ConnWrapper, symbol: str, start_date: str, n: int):
    """Return (price, actual_date) n trading days after start_date from stock_ohlcv."""
    rows = conn.execute("""
        SELECT close, date FROM stock_ohlcv
        WHERE symbol = ? AND date > ?
        ORDER BY date ASC
        LIMIT ?
    """, (symbol, start_date, n + 5)).fetchall()
    if len(rows) < n:
        return None, None
    return rows[n - 1][0], rows[n - 1][1]

def compute_return(entry, exit_p):
    if entry is None or exit_p is None or entry == 0:
        return None
    return round((exit_p - entry) / entry * 100, 4)

def resolve_outcomes(dry_run = False):
    conn = connect()
    try:
        # Query appearances that are not fully resolved (where return_5d is still NULL)
        q = """
            SELECT a.id as appearance_id, a.symbol, a.filter_key, a.price as entry_price, r.timestamp
            FROM live_screener_appearances a
            JOIN live_screener_runs r ON a.run_id = r.id
            LEFT JOIN live_screener_outcomes o ON a.id = o.appearance_id
            WHERE o.appearance_id IS NULL OR o.return_5d IS NULL
        """
        pending = conn.execute(q).fetchall()
        if not pending:
            print("[LiveScreenerResolver] No pending appearances to resolve.")
            return

        print(f"[LiveScreenerResolver] Found {len(pending)} pending appearances to process.")
        resolved_count = 0

        for row in pending:
            app_id = row['appearance_id']
            symbol = row['symbol']
            filter_key = row['filter_key']
            entry_price = row['entry_price']
            timestamp = row['timestamp']
            
            # The appeared date is the date portion of the run timestamp (e.g. YYYY-MM-DD)
            appeared_date = timestamp[:10]

            # Fetch EOD close prices at 1d, 3d, 5d horizons
            close_1d, _ = get_trading_days_after(conn, symbol, appeared_date, 1)
            close_3d, _ = get_trading_days_after(conn, symbol, appeared_date, 3)
            close_5d, _ = get_trading_days_after(conn, symbol, appeared_date, 5)

            ret_1d = compute_return(entry_price, close_1d)
            ret_3d = compute_return(entry_price, close_3d)
            ret_5d = compute_return(entry_price, close_5d)

            # Only proceed if we resolved at least some return data
            if ret_1d is not None or ret_3d is not None or ret_5d is not None:
                if dry_run:
                    print(f"[DRY-RUN] ID {app_id} ({symbol}): Entry={entry_price}, 1d={ret_1d}%, 3d={ret_3d}%, 5d={ret_5d}%")
                else:
                    conn.execute("""
                        INSERT INTO live_screener_outcomes (
                            appearance_id, symbol, filter_key, appeared_at, entry_price, return_1d, return_3d, return_5d
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(appearance_id) DO UPDATE SET
                            return_1d = excluded.return_1d,
                            return_3d = excluded.return_3d,
                            return_5d = excluded.return_5d
                    """, (app_id, symbol, filter_key, appeared_date, entry_price, ret_1d, ret_3d, ret_5d))
                resolved_count += 1

        if not dry_run:
            conn.commit()
            print(f"[LiveScreenerResolver] Successfully resolved and committed {resolved_count} outcomes.")
        else:
            print(f"[LiveScreenerResolver] Dry-run: processed {resolved_count} outcomes (no commit).")

    except Exception as e:
        print(f"[LiveScreenerResolver] Error during outcome resolution: {e}")
        conn.rollback()
        raise e
    finally:
        conn.close()

if __name__ == '__main__':
    dry = "--dry-run" in sys.argv
    resolve_outcomes(dry)
