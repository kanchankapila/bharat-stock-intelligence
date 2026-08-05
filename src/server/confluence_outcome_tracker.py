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

from datetime import datetime, timedelta

from db_compat import connect

HORIZONS = [1, 3, 7, 14, 30]

def get_connection():
    return connect()

def get_ohlcv_close_cached(ohlcv_cache, symbol: str, date_str: str):
    """Get closing price on or after date_str (up to 5 trading/calendar days forward) from in-memory cache."""
    sym_cache = ohlcv_cache.get(symbol)
    if not sym_cache:
        return None, None
    for offset in range(5):
        target = (datetime.strptime(date_str, '%Y-%m-%d') + timedelta(days=offset)).strftime('%Y-%m-%d')
        close = sym_cache.get(target)
        if close is not None:
            return close, target
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

    # Load all OHLCV closing prices in memory to avoid N+1 queries. is_suspect-guarded to match
    # outcome_resolver.py's (the technical-sourced sibling writer) existing convention -- this
    # cache previously had zero data-quality guarding, so a confluence signal_outcomes row could
    # price its exit off a known-bad bar (2026-08-04: live-verified 52% of extreme screener
    # return_20d rows trace to an is_suspect bar in the exit window -- the same contamination
    # class, just discovered via a different table this time).
    ohlcv_cache = {}
    print("[OUTCOME-TRACKER] Loading OHLCV cache into memory...")
    ohlcv_rows = conn.execute(
        "SELECT symbol, date, close FROM stock_ohlcv "
        "WHERE close IS NOT NULL AND close > 0 AND COALESCE(is_suspect, 0) = 0"
    ).fetchall()
    for row in ohlcv_rows:
        sym = row['symbol']
        dt = str(row['date'])
        close = float(row['close'])
        if sym not in ohlcv_cache:
            ohlcv_cache[sym] = {}
        ohlcv_cache[sym][dt] = close
    print(f"[OUTCOME-TRACKER] Loaded {len(ohlcv_rows)} closing prices for {len(ohlcv_cache)} symbols")

    # Load existing outcomes to skip already-resolved ones. Scoped to signal_source='confluence'
    # (2026-08): this used to key on ANY row for (symbol, signal_date, horizon_days) regardless
    # of writer, so it silently skipped horizons outcome_resolver.py had already claimed (and
    # vice versa) instead of writing its own, correctly-attributed row alongside — see the
    # signal_outcomes.signal_source migration for the full mechanism.
    existing_outcomes = set()
    existing_rows = conn.execute(
        "SELECT symbol, signal_date, horizon_days FROM signal_outcomes WHERE signal_source = 'confluence'"
    ).fetchall()
    for row in existing_rows:
        sig_date_str = str(row['signal_date'])
        existing_outcomes.add((row['symbol'], sig_date_str, int(row['horizon_days'])))

    insert_sql = """
        INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price,
          check_date, exit_price, return_pct, outcome, signal_source, label_definition)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confluence', 'terminal_pct2')
        ON CONFLICT(symbol, signal_date, horizon_days, signal_source) DO UPDATE SET
          exit_price = excluded.exit_price,
          return_pct = excluded.return_pct,
          outcome    = excluded.outcome,
          check_date = excluded.check_date,
          label_definition = excluded.label_definition
    """

    params_list = []
    tracked = 0
    for row in signal_rows:
        symbol = row['symbol']
        # Postgres DATE(computed_at) yields a date object; SQLite yields a 'YYYY-MM-DD' string.
        signal_date = str(row['signal_date'])
        entry_price = float(row['current_price'])

        for horizon in HORIZONS:
            if (symbol, signal_date, horizon) in existing_outcomes:
                continue

            exit_date = (datetime.strptime(signal_date, '%Y-%m-%d') + timedelta(days=horizon)).strftime('%Y-%m-%d')
            if exit_date > today:
                continue  # not yet

            exit_price, actual_exit_date = get_ohlcv_close_cached(ohlcv_cache, symbol, exit_date)
            if exit_price is None or entry_price <= 0:
                continue

            return_pct = (exit_price - entry_price) / entry_price * 100
            outcome = 'WIN' if return_pct > 2.0 else ('LOSS' if return_pct < -2.0 else 'NEUTRAL')

            params_list.append((symbol, signal_date, horizon, entry_price, actual_exit_date, exit_price, return_pct, outcome))
            tracked += 1

            if len(params_list) >= 5000:
                conn.executemany(insert_sql, params_list)
                params_list = []

    if params_list:
        conn.executemany(insert_sql, params_list)

    conn.commit()
    print(f'[OUTCOME-TRACKER] Tracked {tracked} outcomes')
    return tracked

def recompute_screener_reliability(conn):
    """Recompute win rates for every screener based on signal_outcomes.

    NOTE: doesn't cover et_marketstats (2026-08-04) -- that source has no dedicated screeners
    table to UNION in here the way the other 3 do; left as a known, documented gap rather than
    guessed at, since et_marketstats' screener-membership schema wasn't audited as part of this
    pass. et_marketstats screeners still get measured via screener_performance.py's
    appearance-based pipeline (screener_master-driven, all 4 sources), just not via this
    signal_outcomes-based path.
    """
    screeners = conn.execute("""
        SELECT screener_id AS scan_id, screener_name, 'trendlyne' AS source FROM trendlyne_screeners
        UNION ALL
        SELECT scan_id, screener_name, 'moneycontrol' AS source FROM moneycontrol_screeners
        UNION ALL
        SELECT screener_id AS scan_id, screener_name, 'etnow' AS source FROM etnow_screeners
    """).fetchall()

    # sign per (source, scan_id) -- screener_master.source is capitalized ('Trendlyne') while
    # the `source` values above are lowercase; match case-insensitively. Unknown/unmatched
    # defaults to bullish (sign=+1, unchanged prior behavior) -- see screener_performance.py's
    # _sign_for_sentiment for the full rationale (only a CONFIRMED bearish tag flips).
    sentiment_rows = conn.execute("SELECT scan_id, source, inferred_sentiment FROM screener_master").fetchall()
    sentiment_by_key = {(r['scan_id'], r['source'].lower()): r['inferred_sentiment'] for r in sentiment_rows}

    updated = 0
    for screener in screeners:
        scan_id = screener['scan_id']
        source = screener['source']
        sign = -1.0 if sentiment_by_key.get((scan_id, source)) == 'bearish' else 1.0

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

        # 7-day win rate. signal_source='confluence' (2026-08): this table also carries
        # technical-sourced h7/h30 rows if outcome_resolver.py is ever extended to those
        # horizons later — without this filter that would silently blend two different
        # methodologies into "screener reliability", which is specifically about how this
        # script's OWN confluence-signal grading performed.
        #
        # is_suspect-guarded (2026-08-04): signal_outcomes.is_suspect is a post-hoc magnitude
        # flag maintained by data_integrity_repair.py, independent of this script's own OHLCV
        # cache guard above -- catches rows written before that repair last ran.
        #
        # Sign-aware (2026-08-04): outcome/return_pct are stored price-direction-only ('WIN' =
        # price rose >2%), correct for a bullish screener but backwards for a confirmed bearish
        # one (a bearish screener wins when the stock falls). For sign=-1 this flips WIN<->LOSS
        # counting and negates return_pct so avg_return/reliability read as "did the screener's
        # own predicted direction pay off," not "did price go up." See
        # screener_performance.py::_sign_for_sentiment for the same convention applied to the
        # appearance-based pipeline.
        wins_case = "outcome = 'WIN'" if sign > 0 else "outcome = 'LOSS'"
        stats_7 = conn.execute(f"""
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN {wins_case} THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN ? * return_pct END) AS avg_return
            FROM signal_outcomes
            WHERE symbol IN ({placeholders}) AND horizon_days = 7 AND signal_source = 'confluence'
              AND outcome IN ('WIN','LOSS','NEUTRAL') AND (is_suspect IS NULL OR is_suspect = 0)
        """, [sign] + symbols).fetchone()

        # 30-day win rate
        stats_30 = conn.execute(f"""
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN {wins_case} THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN ? * return_pct END) AS avg_return,
              MAX(CASE WHEN ? * return_pct < 0 THEN ABS(? * return_pct) ELSE 0 END) AS max_dd
            FROM signal_outcomes
            WHERE symbol IN ({placeholders}) AND horizon_days = 30 AND signal_source = 'confluence'
              AND outcome IN ('WIN','LOSS','NEUTRAL') AND (is_suspect IS NULL OR is_suspect = 0)
        """, [sign, sign, sign] + symbols).fetchone()

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
            min(max(avg_ret_7, 0), 10) / 10 * 20 +
            (1 - min(max_dd, 20) / 20) * 10
        ))

        conn.execute("""
            INSERT INTO screener_reliability (
              scan_id, screener_name, source, total_signals,
              wins_7d, win_rate_7d, avg_return_7d,
              wins_30d, win_rate_30d, avg_return_30d,
              max_drawdown, reliability_score, last_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(source, scan_id) DO UPDATE SET
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
