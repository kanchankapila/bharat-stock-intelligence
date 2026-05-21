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

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

WIN_THRESHOLD  =  1.0   # > +1% = WIN
LOSS_THRESHOLD = -1.0   # < -1% = LOSS


def resolve_outcomes(
    conn: sqlite3.Connection,
    horizon_days: int = 15,
    dry_run: bool = False,
) -> dict[str, int]:
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

    print(f"[OutcomeResolver] {len(rows)} signals pending resolution.")
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

        exit_target  = (datetime.date.fromisoformat(signal_date)
                        + datetime.timedelta(days=horizon_days)).isoformat()

        outcome      = None
        exit_price   = None
        check_date   = None
        return_pct   = None

        if stop_loss:
            sl_hit = conn.execute("""
                SELECT date, low FROM stock_ohlcv
                WHERE symbol = ? AND date > ? AND date <= ?
                  AND low <= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, signal_date, exit_target, stop_loss)).fetchone()

            if sl_hit:
                check_date = sl_hit[0]
                exit_price = float(stop_loss)
                return_pct = (exit_price - entry) / entry * 100
                outcome    = 'STOP_LOSS'

        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target)).fetchone()

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
            msg = f"  [DRY] {sym} {signal_date} → {outcome}"
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


def run(horizon_days: int = 15, dry_run: bool = False):
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"[OutcomeResolver] DB not found: {DB_PATH}. Run from project root.")
    conn = sqlite3.connect(DB_PATH)
    try:
        resolve_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--horizon',  type=int, default=15)
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()
    run(horizon_days=args.horizon, dry_run=args.dry_run)
