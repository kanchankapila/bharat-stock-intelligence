"""
OHLCV data-quality guard.

stock_ohlcv is already split/dividend-adjusted (backfill_ohlcv uses yf auto_adjust=True), so
real corporate actions don't create cliffs. The phantom day-over-day jumps that poison
outcome labels are instead (a) bad/duplicate prints from the source feed and (b) the seam
where raw live appends meet adjusted history around a recent split.

This flags single-bar bad prints — a bar that deviates beyond `threshold` from BOTH its
neighbours (a spike), which a genuine level shift / split seam does NOT do — and writes
stock_ohlcv.is_suspect so label/feature code can exclude them. A corporate-action allowlist
(ingested from yfinance) suppresses flags around legitimate ex-dates as a safety net.

  python ohlcv_quality.py             # ingest actions, then flag bad prints
  python ohlcv_quality.py --no-ingest # flag from already-ingested actions only
"""
import argparse
import datetime

from db_compat import connect, ConnWrapper

BAD_PRINT_THRESHOLD = 0.35   # > 35% day-over-day vs BOTH neighbours = suspect spike
ACTION_WINDOW_DAYS = 3       # don't flag within ±3d of a known ex-date


# ── corporate-action parsing (allowlist source) ─────────────────────────────────

def parse_split_actions(splits):
    out = []
    if splits is None:
        return out
    for ts, ratio in splits.items():
        r = float(ratio) if ratio is not None else 0.0
        if r > 0:
            out.append((ts.date().isoformat(), r))
    return out


def parse_dividend_actions(dividends):
    out = []
    if dividends is None:
        return out
    for ts, amt in dividends.items():
        a = float(amt) if amt is not None else 0.0
        if a > 0:
            out.append((ts.date().isoformat(), a))
    return out


# ── bad-print detection ─────────────────────────────────────────────────────────

def is_bad_print(prev_close, cur_close, next_close,
                 near_known_action: bool = False, threshold: float = BAD_PRINT_THRESHOLD) -> bool:
    """True if `cur_close` is a single-bar spike: it deviates > threshold from BOTH neighbours
    and isn't explained by a known corporate action. A genuine level shift deviates from one
    side only, so it is kept. Boundary bars (a missing neighbour) are never flagged."""
    if near_known_action:
        return False
    if prev_close is None or next_close is None or cur_close is None:
        return False
    if prev_close <= 0 or next_close <= 0:
        return False
    dev_prev = abs(cur_close - prev_close) / prev_close
    dev_next = abs(cur_close - next_close) / next_close
    return dev_prev > threshold and dev_next > threshold


# ── DB jobs ─────────────────────────────────────────────────────────────────────

def ingest_corporate_actions(conn: ConnWrapper, symbols) -> dict:
    """Fetch split + dividend ex-dates per symbol from yfinance into corporate_actions
    (the bad-print allowlist). Splits/bonuses come via .splits, cash dividends via .dividends."""
    import yfinance as yf
    total = 0
    for sym in symbols:
        try:
            t = yf.Ticker(f"{sym}.NS")
            splits = parse_split_actions(t.splits)
            divs = parse_dividend_actions(t.dividends)
        except Exception as e:
            print(f"[OHLCVQuality] {sym}: action fetch failed: {e}")
            continue
        for ex_date, ratio in splits:
            conn.execute(
                "INSERT INTO corporate_actions (symbol, ex_date, action_type, ratio) "
                "VALUES (?,?,'SPLIT',?) "
                "ON CONFLICT(symbol, ex_date, action_type) DO UPDATE SET ratio=excluded.ratio",
                (sym, ex_date, ratio))
            total += 1
        for ex_date, amt in divs:
            conn.execute(
                "INSERT INTO corporate_actions (symbol, ex_date, action_type, amount) "
                "VALUES (?,?,'DIVIDEND',?) "
                "ON CONFLICT(symbol, ex_date, action_type) DO UPDATE SET amount=excluded.amount",
                (sym, ex_date, amt))
            total += 1
    conn.commit()
    print(f"[OHLCVQuality] ingested {total} corporate actions across {len(symbols)} symbols")
    return {'actions': total}


def _within(d1_iso: str, d2_iso: str, days: int) -> bool:
    a = datetime.date.fromisoformat(str(d1_iso)[:10])
    b = datetime.date.fromisoformat(str(d2_iso)[:10])
    return abs((a - b).days) <= days


def flag_bad_prints(conn: ConnWrapper, threshold: float = BAD_PRINT_THRESHOLD,
                    action_window_days: int = ACTION_WINDOW_DAYS) -> dict:
    """Mark stock_ohlcv.is_suspect for single-bar bad prints. Idempotent (resets first)."""
    conn.execute("UPDATE stock_ohlcv SET is_suspect=0 WHERE is_suspect=1")
    conn.commit()

    # Bulk fetch corporate actions
    actions_rows = conn.execute("SELECT symbol, ex_date FROM corporate_actions").fetchall()
    action_map = {}
    for r in actions_rows:
        sym = r[0] if isinstance(r, (list, tuple)) else r['symbol']
        dt  = str(r[1] if isinstance(r, (list, tuple)) else r['ex_date'])[:10]
        if sym not in action_map:
            action_map[sym] = []
        action_map[sym].append(dt)

    # Bulk fetch stock_ohlcv ordered by symbol and date
    print("[OHLCVQuality] Fetching all OHLCV rows for analysis...")
    bars_rows = conn.execute("SELECT symbol, date, close FROM stock_ohlcv ORDER BY symbol, date").fetchall()
    
    # Group bars by symbol in memory
    bars_map = {}
    for r in bars_rows:
        sym = r[0] if isinstance(r, (list, tuple)) else r['symbol']
        dt  = str(r[1] if isinstance(r, (list, tuple)) else r['date'])[:10]
        c   = float(r[2] if isinstance(r, (list, tuple)) else r['close'] or 0)
        if sym not in bars_map:
            bars_map[sym] = []
        bars_map[sym].append((dt, c))

    suspects_to_update = []
    for sym, bars in bars_map.items():
        if len(bars) < 3:
            continue
        action_dates = action_map.get(sym, [])
        for i in range(1, len(bars) - 1):
            d, c = bars[i]
            prev_close = bars[i - 1][1]
            next_close = bars[i + 1][1]
            if prev_close <= 0 or next_close <= 0 or c is None:
                continue
            dev_prev = abs(c - prev_close) / prev_close
            dev_next = abs(c - next_close) / next_close
            if dev_prev > threshold and dev_next > threshold:
                near = any(_within(d, ad, action_window_days) for ad in action_dates)
                if not near:
                    suspects_to_update.append((sym, d))

    print(f"[OHLCVQuality] Flagging {len(suspects_to_update)} suspect bars in database...")
    if suspects_to_update:
        # Was the module-level executemany() helper, which opens its OWN connection via a
        # global get_engine() -- completely bypassing the `conn` this function reads through.
        # In production conn and the global engine usually point at the same live DB so this
        # went unnoticed, but it's wrong (silently writes to whatever get_engine() resolves to,
        # not necessarily `conn`) and made this function untestable against an isolated
        # connection -- flag_bad_prints() always reported the correct count while writing
        # nowhere the caller could see. Route the write through `conn` like every read above.
        conn.executemany(
            "UPDATE stock_ohlcv SET is_suspect=1 WHERE symbol=? AND date=?",
            suspects_to_update
        )
    conn.commit()

    print(f"[OHLCVQuality] flagged {len(suspects_to_update)} suspect bars")
    return {'flagged': len(suspects_to_update)}


def run(ingest: bool = True):
    conn = connect()
    try:
        if ingest:
            symbols = [r[0] for r in conn.execute("SELECT DISTINCT symbol FROM stock_ohlcv").fetchall()]
            ingest_corporate_actions(conn, symbols)
        flag_bad_prints(conn)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-ingest', action='store_true')
    args = parser.parse_args()
    run(ingest=not args.no_ingest)
