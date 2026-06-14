from pathlib import Path
"""
Outcome Resolver
================
Auto-labels technical_signals rows in signal_outcomes using stock_ohlcv.
Detects STOP_LOSS when intraday low crosses below stop_loss before horizon exit.

Run:  python outcome_resolver.py
      python outcome_resolver.py --horizon 5
      python outcome_resolver.py --dry-run
"""

import os, sqlite3, datetime, argparse

DB_PATH      = Path(__file__).parent.parent.parent / "database.sqlite"
WIN_THRESHOLD  =  1.0   # > +1% = WIN
LOSS_THRESHOLD = -1.0   # < -1% = LOSS


def resolve_outcomes(
    conn: sqlite3.Connection,
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
    cutoff    = (today - datetime.timedelta(days=horizon_days)).isoformat()

    # Signals old enough that horizon has passed, not yet resolved
    pending = conn.execute("""
        SELECT ts.symbol, ts.date AS signal_date, ts.cmp AS entry_price,
               ts.signal_score, ts.signals_json,
               CAST(ts.stop_loss AS REAL) AS stop_loss
         FROM technical_signals ts
         WHERE ts.date <= ?
           AND NOT EXISTS (
               SELECT 1 FROM signal_outcomes so2
               WHERE so2.symbol = ts.symbol
                 AND so2.signal_date = ts.date
                 AND so2.horizon_days = ?
                 AND so2.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
           )
         ORDER BY ts.date DESC
         LIMIT 2000
    """, (cutoff, horizon_days)).fetchall()

    cols = ['symbol', 'signal_date', 'entry_price', 'signal_score', 'signals_json', 'stop_loss']
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
        
        if not entry:
            continue

        # PHASE 1 FIX: Entry at next trading day's open
        signal_date_obj = datetime.date.fromisoformat(signal_date)
        
        # Get actual next trading day from DB
        next_trading_day_row = conn.execute("""
            SELECT date FROM stock_ohlcv 
            WHERE symbol = ? AND date > ? 
            ORDER BY date ASC LIMIT 1
        """, (sym, signal_date)).fetchone()
        
        next_trading_day = next_trading_day_row[0] if next_trading_day_row else (signal_date_obj + datetime.timedelta(days=1)).isoformat()
        
        exit_target_date = (signal_date_obj + datetime.timedelta(days=horizon_days)).isoformat()

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
                check_date = sl_hit[0]
                exit_price = float(stop_loss)
                return_pct = (exit_price - entry) / entry * 100
                outcome    = 'STOP_LOSS'

        # If SL not hit, check exit at horizon date (using close price)
        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target_date)).fetchone()

            if exit_row:
                check_date = exit_row[0]
                exit_price = float(exit_row[1])
                return_pct = (exit_price - entry) / entry * 100
                outcome    = ('WIN'  if return_pct > WIN_THRESHOLD  else
                              'LOSS' if return_pct < LOSS_THRESHOLD else
                              'NEUTRAL')
            else:
                outcome    = 'PENDING'
                return_pct = None

        if dry_run:
            msg = f"  [DRY] {sym} {signal_date} (entry:{next_trading_day}) → {outcome}"
            if return_pct is not None:
                msg += f" ({return_pct:.2f}%)"
            print(msg)
            continue

        conn.execute(upsert, (
            sym, signal_date, horizon_days, entry,
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
    conn: sqlite3.Connection,
    horizon_days: int = 1,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    Resolve outcomes for all signal sources (AI, Quant, Technical) from unified_signals.
    """
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=horizon_days)).isoformat()

    pending = conn.execute("""
        SELECT us.id, us.symbol, us.signal_date, us.entry_price, us.stop_loss, us.signal_source, us.confidence_score
        FROM unified_signals us
        WHERE us.signal_date <= ?
          AND us.status != 'COMPLETED'
          AND NOT EXISTS (
              SELECT 1 FROM unified_signal_outcomes uso
              WHERE uso.unified_signal_id = us.id
                AND uso.horizon_days = ?
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
             entry_price, check_date, exit_price, outcome, return_pct, computed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(unified_signal_id, horizon_days) DO UPDATE SET
            check_date=excluded.check_date, exit_price=excluded.exit_price,
            outcome=excluded.outcome, return_pct=excluded.return_pct,
            computed_at=excluded.computed_at
    """

    for row in rows:
        uid = row['id']
        sym = row['symbol']
        signal_date = row['signal_date']
        entry = float(row['entry_price'] or 0)
        stop_loss = float(row['stop_loss']) if row['stop_loss'] else None
        source = row['signal_source']

        if not entry:
            continue

        signal_date_obj = datetime.date.fromisoformat(signal_date[:10])
        next_trading_day_row = conn.execute("""
            SELECT date FROM stock_ohlcv 
            WHERE symbol = ? AND date > ? 
            ORDER BY date ASC LIMIT 1
        """, (sym, signal_date[:10])).fetchone()
        
        next_trading_day = next_trading_day_row[0] if next_trading_day_row else (signal_date_obj + datetime.timedelta(days=1)).isoformat()
        exit_target_date = (signal_date_obj + datetime.timedelta(days=horizon_days)).isoformat()

        outcome, exit_price, check_date, return_pct = None, None, None, None

        if stop_loss and stop_loss > 0:
            sl_hit = conn.execute("""
                SELECT date, low FROM stock_ohlcv
                WHERE symbol = ? AND date >= ? AND date <= ? AND low <= ?
                ORDER BY date ASC, low ASC LIMIT 1
            """, (sym, next_trading_day, exit_target_date, stop_loss)).fetchone()

            if sl_hit:
                check_date = sl_hit[0]
                exit_price = float(stop_loss)
                return_pct = (exit_price - entry) / entry * 100
                outcome = 'STOP_LOSS'

        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target_date)).fetchone()

            if exit_row:
                check_date = exit_row[0]
                exit_price = float(exit_row[1])
                return_pct = (exit_price - entry) / entry * 100
                outcome = ('WIN' if return_pct > WIN_THRESHOLD else
                           'LOSS' if return_pct < LOSS_THRESHOLD else
                           'NEUTRAL')
            else:
                outcome = 'PENDING'

        if dry_run:
            msg = f"  [DRY] UNIFIED {sym} {signal_date} (entry:{next_trading_day}) → {outcome}"
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


def expire_stale_pending(conn: sqlite3.Connection, horizon_days: int, dry_run: bool = False) -> int:
    """Mark PENDING outcomes older than 2×horizon as NEUTRAL (stock/data unavailable)."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=horizon_days * 2)).isoformat()

    rows = conn.execute("""
        SELECT symbol, signal_date, horizon_days
        FROM signal_outcomes
        WHERE outcome = 'PENDING'
          AND horizon_days = ?
          AND signal_date < ?
    """, (horizon_days, cutoff)).fetchall()

    if dry_run:
        print(f"[OutcomeResolver] Would expire {len(rows)} stale {horizon_days}D PENDING outcomes")
        return len(rows)

    conn.execute("""
        UPDATE signal_outcomes
        SET outcome = 'NEUTRAL',
            return_pct = 0.0,
            computed_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING'
          AND horizon_days = ?
          AND signal_date < ?
    """, (horizon_days, cutoff))
    conn.commit()
    print(f"[OutcomeResolver] Expired {len(rows)} stale {horizon_days}D outcomes -> NEUTRAL")
    return len(rows)


def resolve_recommendation_log(
    conn: sqlite3.Connection,
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
        WHERE outcome IS NULL
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
        signal_date = row['signal_date']
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
                return_pct = (exit_price - entry) / entry * 100
                outcome = 'LOSS'

        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target_date)).fetchone()

            if exit_row:
                exit_price = float(exit_row[1])
                return_pct = (exit_price - entry) / entry * 100
                outcome = ('WIN'  if return_pct > WIN_THRESHOLD  else
                           'LOSS' if return_pct < LOSS_THRESHOLD else
                           'NEUTRAL')
            else:
                outcome = 'PENDING'

        if dry_run:
            msg = f"  [DRY] REC_LOG {sym} {signal_date} → {outcome}"
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
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"[OutcomeResolver] DB not found: {DB_PATH}. Run from project root.")
    conn = sqlite3.connect(DB_PATH)
    try:
        resolve_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_unified_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_recommendation_log(conn, horizon_days=horizon_days, dry_run=dry_run)
        expire_stale_pending(conn, horizon_days=horizon_days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--horizon',  type=int, default=1)
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()
    run(horizon_days=args.horizon, dry_run=args.dry_run)
