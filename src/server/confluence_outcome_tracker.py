#!/usr/bin/env python3
"""
Confluence Outcome Tracker

For each confluence_signal that was generated N days ago:
  1. Look up the stock's closing price at signal_date + N in stock_ohlcv
  2. Compute return_pct at each horizon (1, 3, 7, 14, 30 days)
  3. Upsert into signal_outcomes (reusing existing table structure)
  4. Recompute screener_reliability win rates from signal_outcomes

Run daily after market close:
  python confluence_outcome_tracker.py
"""

import os
import sqlite3
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'database.sqlite')
HORIZONS = [1, 3, 7, 14, 30]

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_ohlcv_close(conn, symbol: str, date_str: str):
    """Get closing price on or after date_str (up to 5 trading days forward)."""
    for offset in range(5):
        target = (datetime.strptime(date_str, '%Y-%m-%d') + timedelta(days=offset)).strftime('%Y-%m-%d')
        row = conn.execute(
            'SELECT close FROM stock_ohlcv WHERE symbol = ? AND date = ?', (symbol, target)
        ).fetchone()
        if row and row['close']:
            return float(row['close']), target
    return None, None

def track_outcomes(conn):
    today = datetime.now().strftime('%Y-%m-%d')

    # Find all unique signal dates from confluence_signals that have entry price
    signal_rows = conn.execute("""
        SELECT DISTINCT symbol, DATE(computed_at) AS signal_date, current_price, screener_ids_json
        FROM confluence_signals
        WHERE current_price IS NOT NULL AND current_price > 0
        AND DATE(computed_at) <= DATE('now', '-1 day')
    """).fetchall()

    tracked = 0
    for row in signal_rows:
        symbol = row['symbol']
        signal_date = row['signal_date']
        entry_price = float(row['current_price'])

        for horizon in HORIZONS:
            exit_date = (datetime.strptime(signal_date, '%Y-%m-%d') + timedelta(days=horizon)).strftime('%Y-%m-%d')
            if exit_date > today:
                continue  # not yet

            exit_price, actual_exit_date = get_ohlcv_close(conn, symbol, exit_date)
            if exit_price is None:
                continue

            return_pct = (exit_price - entry_price) / entry_price * 100
            outcome = 'WIN' if return_pct > 2.0 else ('LOSS' if return_pct < -2.0 else 'NEUTRAL')

            conn.execute("""
                INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price,
                  check_date, exit_price, return_pct, outcome)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, signal_date, horizon_days) DO UPDATE SET
                  exit_price = excluded.exit_price,
                  return_pct = excluded.return_pct,
                  outcome    = excluded.outcome,
                  check_date = excluded.check_date
            """, (symbol, signal_date, horizon, entry_price, actual_exit_date, exit_price, return_pct, outcome))
            tracked += 1

    conn.commit()
    print(f'[OUTCOME-TRACKER] Tracked {tracked} outcomes')
    return tracked

def recompute_screener_reliability(conn):
    """Recompute win rates for every screener based on signal_outcomes."""
    screeners = conn.execute("""
        SELECT scan_id, screener_name, 'trendlyne' AS source FROM trendlyne_screeners
        UNION ALL
        SELECT scan_id, screener_name, 'moneycontrol' AS source FROM moneycontrol_screeners
        UNION ALL
        SELECT screener_id AS scan_id, screener_name, 'etnow' AS source FROM etnow_screeners
    """).fetchall()

    updated = 0
    for screener in screeners:
        scan_id = screener['scan_id']
        source = screener['source']

        # Get all symbols in this screener
        if source == 'trendlyne':
            symbol_rows = conn.execute(
                'SELECT symbol FROM trendlyne_screener_stocks WHERE screener_id = ? AND symbol IS NOT NULL', (scan_id,)
            ).fetchall()
        elif source == 'moneycontrol':
            symbol_rows = conn.execute(
                'SELECT symbol FROM moneycontrol_screener_stocks WHERE scan_id = ? AND symbol IS NOT NULL', (scan_id,)
            ).fetchall()
        else:
            symbol_rows = conn.execute(
                'SELECT symbol FROM etnow_screener_stocks WHERE screener_id = ? AND symbol IS NOT NULL', (scan_id,)
            ).fetchall()

        symbols = [r['symbol'] for r in symbol_rows if r['symbol']]
        if not symbols:
            continue

        placeholders = ','.join(['?'] * len(symbols))

        # 7-day win rate
        stats_7 = conn.execute(f"""
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN return_pct END) AS avg_return
            FROM signal_outcomes
            WHERE symbol IN ({placeholders}) AND horizon_days = 7
              AND outcome IN ('WIN','LOSS','NEUTRAL')
        """, symbols).fetchone()

        # 30-day win rate
        stats_30 = conn.execute(f"""
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN return_pct END) AS avg_return,
              MAX(CASE WHEN return_pct < 0 THEN ABS(return_pct) ELSE 0 END) AS max_dd
            FROM signal_outcomes
            WHERE symbol IN ({placeholders}) AND horizon_days = 30
              AND outcome IN ('WIN','LOSS','NEUTRAL')
        """, symbols).fetchone()

        total = stats_7['total'] or 0
        wins_7 = stats_7['wins'] or 0
        win_rate_7 = wins_7 / total if total > 0 else 0
        avg_ret_7 = stats_7['avg_return'] or 0
        total_30 = stats_30['total'] or 0
        wins_30 = stats_30['wins'] or 0
        win_rate_30 = wins_30 / total_30 if total_30 > 0 else 0
        avg_ret_30 = stats_30['avg_return'] or 0
        max_dd = stats_30['max_dd'] or 0

        # Composite reliability score (0-100)
        reliability = min(100, max(0,
            win_rate_7 * 40 +
            win_rate_30 * 30 +
            min(avg_ret_7, 10) / 10 * 20 +
            (1 - min(max_dd, 20) / 20) * 10
        ))

        conn.execute("""
            INSERT INTO screener_reliability (
              scan_id, screener_name, source, total_signals,
              wins_7d, win_rate_7d, avg_return_7d,
              wins_30d, win_rate_30d, avg_return_30d,
              max_drawdown, reliability_score, last_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(scan_id) DO UPDATE SET
              total_signals   = excluded.total_signals,
              wins_7d         = excluded.wins_7d,
              win_rate_7d     = excluded.win_rate_7d,
              avg_return_7d   = excluded.avg_return_7d,
              wins_30d        = excluded.wins_30d,
              win_rate_30d    = excluded.win_rate_30d,
              avg_return_30d  = excluded.avg_return_30d,
              max_drawdown    = excluded.max_drawdown,
              reliability_score = excluded.reliability_score,
              last_updated    = CURRENT_TIMESTAMP
        """, (
            scan_id, screener['screener_name'], source, total,
            wins_7, round(win_rate_7, 4), round(avg_ret_7, 2),
            wins_30, round(win_rate_30, 4), round(avg_ret_30, 2),
            round(max_dd, 2), round(reliability, 2)
        ))
        updated += 1

    conn.commit()
    print(f'[OUTCOME-TRACKER] Recomputed reliability for {updated} screeners')

if __name__ == '__main__':
    conn = get_connection()
    try:
        track_outcomes(conn)
        recompute_screener_reliability(conn)
    finally:
        conn.close()
