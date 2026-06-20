"""
Outcome Resolver
================
Auto-labels technical_signals rows in signal_outcomes using stock_ohlcv.
Detects STOP_LOSS when intraday low crosses below stop_loss before horizon exit.

Run:  python outcome_resolver.py
      python outcome_resolver.py --horizon 5
      python outcome_resolver.py --dry-run
"""

import datetime, argparse, math, re

from db_compat import connect, ConnWrapper


def parse_horizon(time_horizon_str, default_days: int) -> int:
    """Parse '5 days', '15 days', 'intraday' etc. to integer days."""
    if not time_horizon_str:
        return default_days
    s = str(time_horizon_str).lower().strip()
    if 'intraday' in s or s == '1 day':
        return 1
    m = re.search(r'(\d+)', s)
    if m:
        return max(1, min(30, int(m.group(1))))
    return default_days

WIN_THRESHOLD  =  1.0   # Fallback thresholds
LOSS_THRESHOLD = -1.0

# Round-trip transaction cost (entry + exit), as a % of notional, for Indian delivery
# equity: STT ~0.2% + exchange/SEBI/stamp/GST ~0.05% + slippage ~0.05% ≈ 0.30%. A signal
# is only "right" if it clears costs — win rates measured gross silently mint break-even
# trades as wins, which then mis-train the learned signal weights. Mirrors backtester.py
# (25 bps commission + 10 bps slippage round trip).
ROUND_TRIP_COST_PCT = 0.30


def net_return_pct(gross_return_pct: float, cost_pct: float = ROUND_TRIP_COST_PCT) -> float:
    """Gross % return minus round-trip transaction costs — what the strategy actually keeps."""
    return gross_return_pct - cost_pct


def get_volatility_threshold(conn: ConnWrapper, symbol: str, signal_date: str, horizon_days: int) -> float:
    """
    Calculates a dynamic threshold based on the stock's rolling daily standard deviation.
    Uses 20 trading days prior to signal_date. Scales threshold by sqrt(horizon_days).
    """
    rows = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol = ? AND date <= ?
        ORDER BY date DESC LIMIT 21
    """, (symbol, signal_date)).fetchall()
    
    if len(rows) < 10:
        # Fallback if insufficient history: 1.0% per day scaled by sqrt(time)
        return max(0.5, min(10.0, 1.0 * math.sqrt(horizon_days)))
        
    prices = [float(r[0]) for r in rows][::-1]
    # Daily returns
    returns = [(prices[i] - prices[i-1]) / prices[i-1] for i in range(1, len(prices))]
    
    # Calculate daily volatility
    mean_ret = sum(returns) / len(returns)
    variance = sum((r - mean_ret) ** 2 for r in returns) / (len(returns) - 1)
    daily_vol = math.sqrt(variance) * 100 # percentage
    
    # 1.0 Standard deviation move over the holding horizon
    threshold = daily_vol * math.sqrt(horizon_days)
    
    # Clamp between 0.5% and 15.0% to prevent extreme values
    return max(0.5, min(15.0, threshold))


def resolve_outcomes(
    conn: ConnWrapper,
    horizon_days: int = 1,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    PHASE 1 FIX: Resolve signal outcomes with proper time-of-day validation
    - Signals entered at next trading day's open
    - SL checked on intraday (low) before target (high)
    - Horizon exit checked at close on exit_date
    """
    today     = datetime.date.today()
    # Use a wider cutoff (30 days) to catch signals of any horizon
    cutoff    = (today - datetime.timedelta(days=30)).isoformat()

    # Signals old enough that horizon has passed, not yet resolved
    pending = conn.execute("""
        SELECT ts.symbol, ts.date AS signal_date, ts.cmp AS entry_price,
               ts.signal_score, ts.signals_json,
               CAST(ts.stop_loss AS REAL) AS stop_loss,
               ts.time_horizon
         FROM technical_signals ts
         WHERE ts.date <= ?
           AND NOT EXISTS (
               SELECT 1 FROM signal_outcomes so2
               WHERE so2.symbol = ts.symbol
                 AND so2.signal_date = ts.date
                 AND so2.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
           )
         ORDER BY ts.date DESC
         LIMIT 2000
    """, (cutoff,)).fetchall()

    cols = ['symbol', 'signal_date', 'entry_price', 'signal_score', 'signals_json', 'stop_loss', 'time_horizon']
    rows = [dict(zip(cols, r)) for r in pending]

    if not rows:
        print(f"[OutcomeResolver] No pending signals to resolve (horizon={horizon_days}d).")
        return {'processed': 0, 'resolved': 0}

    print(f"[OutcomeResolver] {len(rows)} signals pending resolution (phase1-fix).")
    resolved = 0

    upsert = """
        INSERT INTO signal_outcomes
            (symbol, signal_date, horizon_days, entry_price,
             check_date, exit_price, return_pct, outcome,
             signal_score, signals_json, computed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(symbol, signal_date, horizon_days) DO UPDATE SET
            check_date=excluded.check_date, exit_price=excluded.exit_price,
            return_pct=excluded.return_pct, outcome=excluded.outcome,
            computed_at=excluded.computed_at
    """

    for row in rows:
        sym          = row['symbol']
        signal_date  = row['signal_date']
        entry        = float(row['entry_price'] or 0)
        stop_loss    = row['stop_loss']
        sig_horizon  = parse_horizon(row.get('time_horizon'), horizon_days)

        # Skip if already resolved at this specific horizon
        if conn.execute(
            "SELECT 1 FROM signal_outcomes WHERE symbol=? AND signal_date=? AND horizon_days=? AND outcome != 'PENDING' LIMIT 1",
            (sym, signal_date, sig_horizon)
        ).fetchone():
            continue

        if not entry:
            continue

        # PHASE 1 FIX: Entry at next trading day's open
        signal_date_obj = datetime.date.fromisoformat(signal_date)
        
        # Get actual next trading day and its open price from DB
        next_trading_day_row = conn.execute("""
            SELECT date, open FROM stock_ohlcv 
            WHERE symbol = ? AND date > ? 
            ORDER BY date ASC LIMIT 1
        """, (sym, signal_date)).fetchone()
        
        if next_trading_day_row:
            next_trading_day = next_trading_day_row[0]
            # Override original entry with the realistic next-day open price
            entry = float(next_trading_day_row[1])
        else:
            next_trading_day = (signal_date_obj + datetime.timedelta(days=1)).isoformat()

        exit_target_date = (signal_date_obj + datetime.timedelta(days=sig_horizon)).isoformat()

        outcome      = None
        exit_price   = None
        check_date   = None
        return_pct   = None

        # PHASE 1 FIX: Check SL on next trading day first (it has priority in intraday)
        if stop_loss and stop_loss > 0:
            sl_hit = conn.execute("""
                SELECT date, low FROM stock_ohlcv
                WHERE symbol = ? AND date >= ? AND date <= ?
                  AND low <= ?
                ORDER BY date ASC, low ASC LIMIT 1
            """, (sym, next_trading_day, exit_target_date, stop_loss)).fetchone()

            if sl_hit:
                check_date = str(sl_hit[0])
                exit_price = float(stop_loss)
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                outcome    = 'STOP_LOSS'

        # If SL not hit, check exit at horizon date (using close price)
        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target_date)).fetchone()

            if exit_row:
                check_date = str(exit_row[0])
                exit_price = float(exit_row[1])
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                
                # Dynamic volatility-adjusted threshold
                threshold = get_volatility_threshold(conn, sym, signal_date, sig_horizon)
                outcome    = ('WIN'  if return_pct > threshold  else
                              'LOSS' if return_pct < -threshold else
                              'NEUTRAL')
            else:
                outcome    = 'PENDING'
                return_pct = None

        if dry_run:
            msg = f"  [DRY] {sym} {signal_date} h={sig_horizon}d (entry:{next_trading_day}) -> {outcome}"
            if return_pct is not None:
                msg += f" ({return_pct:.2f}%)"
            print(msg)
            continue

        conn.execute(upsert, (
            sym, signal_date, sig_horizon, entry,
            check_date, exit_price,
            round(return_pct, 4) if return_pct is not None else None,
            outcome,
            row['signal_score'], row['signals_json'],
        ))
        if outcome != 'PENDING':
            resolved += 1

    if not dry_run:
        conn.commit()

    print(f"[OutcomeResolver] Resolved {resolved}/{len(rows)} signals.")
    return {'processed': len(rows), 'resolved': resolved}


def resolve_unified_outcomes(
    conn: ConnWrapper,
    horizon_days: int = 1,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    Resolve outcomes for all signal sources (AI, Quant, Technical) from unified_signals.
    """
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=horizon_days)).isoformat()

    # NOTE: the dedup intentionally excludes only rows already RESOLVED at this horizon.
    # Rows previously written as PENDING (horizon not yet elapsed / OHLCV missing at the
    # time) MUST be re-selected so they get resolved once data is available. The previous
    # version matched any existing row regardless of outcome, which permanently stranded
    # PENDING signals (root cause of ~86% of AI signals never resolving).
    pending = conn.execute("""
        SELECT us.id, us.symbol, us.signal_date, us.entry_price, us.stop_loss, us.signal_source, us.confidence_score
        FROM unified_signals us
        WHERE us.signal_date <= ?
          AND us.status != 'COMPLETED'
          AND NOT EXISTS (
              SELECT 1 FROM unified_signal_outcomes uso
              WHERE uso.unified_signal_id = us.id
                AND uso.horizon_days = ?
                AND uso.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          )
        ORDER BY us.signal_date DESC
        LIMIT 2000
    """, (cutoff, horizon_days)).fetchall()

    cols = ['id', 'symbol', 'signal_date', 'entry_price', 'stop_loss', 'signal_source', 'confidence_score']
    rows = [dict(zip(cols, r)) for r in pending]

    if not rows:
        print(f"[OutcomeResolver] No pending unified signals to resolve (horizon={horizon_days}d).")
        return {'processed': 0, 'resolved': 0}

    print(f"[OutcomeResolver] {len(rows)} unified signals pending resolution.")
    resolved = 0

    upsert = """
        INSERT INTO unified_signal_outcomes
            (unified_signal_id, signal_source, symbol, signal_date, horizon_days,
             entry_price, entry_time, check_date, exit_price, outcome, return_pct, computed_at)
        VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(unified_signal_id, horizon_days) DO UPDATE SET
            entry_price=excluded.entry_price,
            check_date=excluded.check_date, exit_price=excluded.exit_price,
            outcome=excluded.outcome, return_pct=excluded.return_pct,
            computed_at=excluded.computed_at
    """

    for row in rows:
        uid = row['id']
        sym = row['symbol']
        signal_date = str(row['signal_date'])
        entry = float(row['entry_price'] or 0)
        stop_loss = float(row['stop_loss']) if row['stop_loss'] else None
        source = row['signal_source']

        if not entry:
            continue

        signal_date_obj = datetime.date.fromisoformat(signal_date[:10])
        next_trading_day_row = conn.execute("""
            SELECT date, open FROM stock_ohlcv 
            WHERE symbol = ? AND date > ? 
            ORDER BY date ASC LIMIT 1
        """, (sym, signal_date[:10])).fetchone()
        
        if next_trading_day_row:
            next_trading_day = next_trading_day_row[0]
            # Override original entry with the realistic next-day open price
            entry = float(next_trading_day_row[1])
        else:
            next_trading_day = (signal_date_obj + datetime.timedelta(days=1)).isoformat()
            
        exit_target_date = (signal_date_obj + datetime.timedelta(days=horizon_days)).isoformat()

        outcome, exit_price, check_date, return_pct = None, None, None, None

        if stop_loss and stop_loss > 0:
            sl_hit = conn.execute("""
                SELECT date, low FROM stock_ohlcv
                WHERE symbol = ? AND date >= ? AND date <= ? AND low <= ?
                ORDER BY date ASC, low ASC LIMIT 1
            """, (sym, next_trading_day, exit_target_date, stop_loss)).fetchone()

            if sl_hit:
                check_date = str(sl_hit[0])
                exit_price = float(stop_loss)
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                outcome = 'STOP_LOSS'

        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target_date)).fetchone()

            if exit_row:
                check_date = str(exit_row[0])
                exit_price = float(exit_row[1])
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                
                # Dynamic volatility-adjusted threshold
                threshold = get_volatility_threshold(conn, sym, signal_date, horizon_days)
                outcome = ('WIN' if return_pct > threshold else
                           'LOSS' if return_pct < -threshold else
                           'NEUTRAL')
            else:
                outcome = 'PENDING'

        if dry_run:
            msg = f"  [DRY] UNIFIED {sym} {signal_date} (entry:{next_trading_day}) -> {outcome}"
            if return_pct is not None: msg += f" ({return_pct:.2f}%)"
            print(msg)
            continue

        conn.execute(upsert, (
            uid, source, sym, signal_date, horizon_days, entry,
            check_date, exit_price, outcome,
            round(return_pct, 4) if return_pct is not None else None,
        ))
        
        if outcome != 'PENDING':
            conn.execute("UPDATE unified_signals SET status = 'COMPLETED' WHERE id = ?", (uid,))
            resolved += 1

    if not dry_run:
        conn.commit()

    print(f"[OutcomeResolver] Resolved {resolved}/{len(rows)} unified signals.")
    return {'processed': len(rows), 'resolved': resolved}


def resolve_dl_predictions(conn: ConnWrapper, dry_run: bool = False) -> dict[str, int]:
    """
    Grade deep_learning_predictions whose horizon has elapsed.
    Fills actual_ret_5d / actual_ret_15d and outcome_5d / outcome_15d ('UP'|'DOWN'|'FLAT')
    using realistic next-trading-day entry and horizon-close exit from stock_ohlcv.
    Nothing graded these before, so all rows sat NULL forever.
    """
    today = datetime.date.today()

    def grade_for(col_ret: str, col_out: str, horizon: int) -> int:
        cutoff = (today - datetime.timedelta(days=horizon)).isoformat()
        pending = conn.execute(f"""
            SELECT id, symbol, prediction_date
            FROM deep_learning_predictions
            WHERE {col_out} IS NULL
              AND substr(prediction_date, 1, 10) <= ?
            ORDER BY prediction_date DESC
            LIMIT 5000
        """, (cutoff,)).fetchall()

        graded = 0
        for pid, sym, pred_date in pending:
            pd_str = str(pred_date)[:10]
            try:
                pd_obj = datetime.date.fromisoformat(pd_str)
            except ValueError:
                continue

            entry_row = conn.execute(
                "SELECT open FROM stock_ohlcv WHERE symbol=? AND date > ? ORDER BY date ASC LIMIT 1",
                (sym, pd_str),
            ).fetchone()
            exit_target = (pd_obj + datetime.timedelta(days=horizon)).isoformat()
            exit_row = conn.execute(
                "SELECT close FROM stock_ohlcv WHERE symbol=? AND date >= ? ORDER BY date ASC LIMIT 1",
                (sym, exit_target),
            ).fetchone()

            if not entry_row or not exit_row:
                continue  # leave NULL; will retry next run once OHLCV lands
            entry = float(entry_row[0] or 0)
            if entry <= 0:
                continue
            ret = (float(exit_row[0]) - entry) / entry * 100
            outcome = 'UP' if ret > 0.5 else 'DOWN' if ret < -0.5 else 'FLAT'

            if dry_run:
                continue
            conn.execute(
                f"UPDATE deep_learning_predictions SET {col_ret}=?, {col_out}=? WHERE id=?",
                (round(ret, 4), outcome, pid),
            )
            graded += 1
        return graded

    g5 = grade_for('actual_ret_5d', 'outcome_5d', 5)
    g15 = grade_for('actual_ret_15d', 'outcome_15d', 15)
    if not dry_run:
        conn.commit()
    print(f"[OutcomeResolver] Graded DL predictions: 5d={g5}, 15d={g15}")
    return {'graded_5d': g5, 'graded_15d': g15}


def expire_stale_pending(conn: ConnWrapper, horizon_days: int, dry_run: bool = False) -> int:
    """Mark PENDING outcomes older than 2×horizon as NEUTRAL (stock/data unavailable).
    Covers signal_outcomes, unified_signal_outcomes and recommendation_log so no table
    accumulates permanently-stuck PENDING rows."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=horizon_days * 2)).isoformat()

    rows = conn.execute("""
        SELECT symbol, signal_date, horizon_days
        FROM signal_outcomes
        WHERE outcome = 'PENDING'
          AND horizon_days = ?
          AND signal_date < ?
    """, (horizon_days, cutoff)).fetchall()

    # unified + rec_log stale PENDING counts (for logging)
    uni_stale = conn.execute("""
        SELECT COUNT(*) FROM unified_signal_outcomes
        WHERE outcome = 'PENDING' AND horizon_days = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff)).fetchone()[0]
    rec_stale = conn.execute("""
        SELECT COUNT(*) FROM recommendation_log
        WHERE outcome = 'PENDING' AND COALESCE(horizon_days, 15) = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff)).fetchone()[0]

    if dry_run:
        print(f"[OutcomeResolver] Would expire {len(rows)} signal_outcomes, "
              f"{uni_stale} unified, {rec_stale} rec_log stale {horizon_days}D PENDING")
        return len(rows)

    conn.execute("""
        UPDATE signal_outcomes
        SET outcome = 'NEUTRAL', return_pct = 0.0, computed_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING' AND horizon_days = ? AND signal_date < ?
    """, (horizon_days, cutoff))
    conn.execute("""
        UPDATE unified_signal_outcomes
        SET outcome = 'NEUTRAL', return_pct = 0.0, computed_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING' AND horizon_days = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff))
    conn.execute("""
        UPDATE recommendation_log
        SET outcome = 'NEUTRAL', actual_return_pct = 0.0,
            status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING' AND COALESCE(horizon_days, 15) = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff))
    conn.commit()
    print(f"[OutcomeResolver] Expired stale {horizon_days}D PENDING -> NEUTRAL "
          f"(signal_outcomes={len(rows)}, unified={uni_stale}, rec_log={rec_stale})")
    return len(rows)


def resolve_recommendation_log(
    conn: ConnWrapper,
    horizon_days: int = 15,
    dry_run: bool = False,
) -> dict[str, int]:
    """Resolve recommendation_log.outcome by checking OHLCV data after the signal horizon."""
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=horizon_days)).isoformat()

    pending = conn.execute("""
        SELECT id, symbol, signal_date, entry_price, stop_loss,
               COALESCE(horizon_days, ?) AS rl_horizon
        FROM recommendation_log
        WHERE (outcome IS NULL OR outcome = 'PENDING')
          AND entry_price IS NOT NULL
          AND signal_date <= ?
        ORDER BY signal_date DESC
        LIMIT 2000
    """, (horizon_days, cutoff)).fetchall()

    cols = ['id', 'symbol', 'signal_date', 'entry_price', 'stop_loss', 'rl_horizon']
    rows = [dict(zip(cols, r)) for r in pending]

    if not rows:
        print("[OutcomeResolver] No pending recommendation_log entries to resolve.")
        return {'processed': 0, 'resolved': 0}

    print(f"[OutcomeResolver] {len(rows)} recommendation_log entries pending resolution.")
    resolved = 0

    for row in rows:
        rec_id = row['id']
        sym = row['symbol']
        signal_date = str(row['signal_date'])
        entry = float(row['entry_price'] or 0)
        stop_loss = float(row['stop_loss']) if row['stop_loss'] else None
        h = int(row['rl_horizon'] or horizon_days)

        if not entry:
            continue

        signal_date_str = signal_date[:10]
        signal_date_obj = datetime.date.fromisoformat(signal_date_str)

        next_row = conn.execute(
            "SELECT date FROM stock_ohlcv WHERE symbol = ? AND date > ? ORDER BY date ASC LIMIT 1",
            (sym, signal_date_str)
        ).fetchone()
        next_trading_day = next_row[0] if next_row else (signal_date_obj + datetime.timedelta(days=1)).isoformat()
        exit_target_date = (signal_date_obj + datetime.timedelta(days=h)).isoformat()

        outcome, exit_price, return_pct = None, None, None

        if stop_loss and stop_loss > 0:
            sl_hit = conn.execute("""
                SELECT date, low FROM stock_ohlcv
                WHERE symbol = ? AND date >= ? AND date <= ? AND low <= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, next_trading_day, exit_target_date, stop_loss)).fetchone()

            if sl_hit:
                exit_price = float(stop_loss)
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                outcome = 'LOSS'

        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target_date)).fetchone()

            if exit_row:
                exit_price = float(exit_row[1])
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                
                # Dynamic volatility-adjusted threshold
                threshold = get_volatility_threshold(conn, sym, signal_date, h)
                outcome = ('WIN'  if return_pct > threshold  else
                           'LOSS' if return_pct < -threshold else
                           'NEUTRAL')
            else:
                outcome = 'PENDING'

        if dry_run:
            msg = f"  [DRY] REC_LOG {sym} {signal_date} -> {outcome}"
            if return_pct is not None:
                msg += f" ({return_pct:.2f}%)"
            print(msg)
            continue

        conn.execute("""
            UPDATE recommendation_log
            SET outcome = ?,
                actual_exit_price = ?,
                actual_return_pct = ?,
                status = CASE WHEN ? != 'PENDING' THEN 'RESOLVED' ELSE status END,
                resolved_at = CASE WHEN ? != 'PENDING' THEN CURRENT_TIMESTAMP ELSE resolved_at END
            WHERE id = ?
        """, (outcome, exit_price,
              round(return_pct, 4) if return_pct is not None else None,
              outcome, outcome, rec_id))

        if outcome != 'PENDING':
            resolved += 1

    if not dry_run:
        conn.commit()

    print(f"[OutcomeResolver] Resolved {resolved}/{len(rows)} recommendation_log entries.")
    return {'processed': len(rows), 'resolved': resolved}


def run(horizon_days: int = 1, dry_run: bool = False):
    conn = connect()
    try:
        resolve_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_unified_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_recommendation_log(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_dl_predictions(conn, dry_run=dry_run)
        expire_stale_pending(conn, horizon_days=horizon_days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--horizon',  type=int, default=1)
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()
    run(horizon_days=args.horizon, dry_run=args.dry_run)
