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
import polars as pl
import argparse
import datetime
from datetime import timedelta, timezone

from db_compat import connect, ConnWrapper
from hypertable_safe_write import safe_keyed_update
import sys

BAD_PRINT_THRESHOLD = 0.35   # > 35% day-over-day vs BOTH neighbours = suspect spike
ACTION_WINDOW_DAYS = 3       # don't flag within ±3d of a known ex-date

# ingest_corporate_actions() is one of the report's two 150-minute steps (scheduler-review,
# 2026-09-04) -- a per-symbol yfinance .splits/.dividends call across the whole universe every
# run. Splits/dividends are declared a handful of times a year per stock, so re-checking a
# symbol we already asked within the last week wastes almost the entire run for almost no new
# data. Same staleness window as marketsmojo_financials_fetcher.py's STALENESS_DAYS, same
# reasoning: short enough that a stock whose corporate-action calendar changes (a newly
# announced split) is caught within a week, long enough to skip the vast majority of a universe
# that has nothing new to report on any given day.
CORPORATE_ACTIONS_STALENESS_DAYS = 7

# is_bad_print/flag_bad_prints only catch a transient single-bar SPIKE (deviates from both
# neighbours, then reverts) -- by design a genuine level shift is kept, since that's meant to
# protect real corporate-action repricing. But that also means a SUSTAINED, non-reverting jump
# slips through untouched even when it's not a real corporate action -- e.g. a split-adjustment
# seam between this codebase's two OHLCV sources (deep MC backfill vs live yfinance daily
# appends, see mc_ohlcv_backfill.py's docstring) for a symbol whose split happened after the
# initial backfill. Found 2026-07-19: ARIHANT jumps from ~40 to ~930 on 2026-04-20 and STAYS
# there for the following week -- not a spike, is_bad_print correctly doesn't flag it, but no
# real NSE stock moves 2200% in one session either. EXTREME_SHIFT_THRESHOLD is set far above
# anything a real single-day move (even a freak one) could produce, so it's safe to flag off a
# single neighbour without requiring reversion -- still gated by the same corporate-action
# allowlist so a real, legitimate large repricing is never flagged.
EXTREME_SHIFT_THRESHOLD = 0.75  # > 75% vs prior close, un-reverted = still flagged


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

def load_recently_checked(conn, staleness_days: int = CORPORATE_ACTIONS_STALENESS_DAYS) -> set[str]:
    """Symbols checked within the staleness window -- corporate_actions itself is an EVENT
    table (no row at all for a symbol with no recent split/dividend), so it cannot answer
    "did we already check this symbol recently" the way a plain freshness column could. Same
    shape as marketsmojo_financials_fetcher.py's identically-named function."""
    cutoff = (datetime.datetime.now(timezone.utc) - timedelta(days=staleness_days)).isoformat()
    rows = conn.execute(
        "SELECT symbol FROM ohlcv_corporate_actions_checked WHERE checked_at >= ?", (cutoff,)
    ).fetchall()
    return {(r[0] if isinstance(r, (list, tuple)) else r['symbol']) for r in rows}


def mark_checked(conn, symbol: str) -> None:
    conn.execute(
        """
        INSERT INTO ohlcv_corporate_actions_checked (symbol, checked_at) VALUES (?, ?)
        ON CONFLICT(symbol) DO UPDATE SET checked_at = excluded.checked_at
        """,
        (symbol, datetime.datetime.now(timezone.utc).isoformat()),
    )


def ingest_corporate_actions(conn: ConnWrapper, symbols, force: bool = False) -> dict:
    """Fetch split + dividend ex-dates per symbol from yfinance into corporate_actions
    (the bad-print allowlist). Splits/bonuses come via .splits, cash dividends via .dividends.

    Skips a symbol checked within CORPORATE_ACTIONS_STALENESS_DAYS (force=True bypasses this,
    e.g. for an explicit single-symbol re-check)."""
    import yfinance as yf
    all_symbols = list(symbols)
    if force:
        stocks = all_symbols
    else:
        recently_checked = load_recently_checked(conn)
        stocks = [s for s in all_symbols if s not in recently_checked]
        skipped = len(all_symbols) - len(stocks)
        if skipped > 0:
            print(f"[OHLCVQuality] Smart cadence skip: {skipped}/{len(all_symbols)} symbols "
                  f"already checked within last {CORPORATE_ACTIONS_STALENESS_DAYS} days. "
                  f"Processing {len(stocks)} remaining.")
    total = 0
    for sym in stocks:
        try:
            t = yf.Ticker(f"{sym}.NS")
            splits = parse_split_actions(t.splits)
            divs = parse_dividend_actions(t.dividends)
        except Exception as e:
            print(f"[OHLCVQuality] {sym}: action fetch failed: {e}", file=sys.stderr)
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
        # Mark checked regardless of whether this symbol had any actions -- an empty result
        # is still an answer, same convention as marketsmojo_financials_fetcher.py's run().
        mark_checked(conn, sym)
    conn.commit()
    print(f"[OHLCVQuality] ingested {total} corporate actions across {len(stocks)} symbols")
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


def flag_extreme_level_shifts(conn: ConnWrapper, threshold: float = EXTREME_SHIFT_THRESHOLD,
                              action_window_days: int = ACTION_WINDOW_DAYS) -> dict:
    """Mark stock_ohlcv.is_suspect for single-day moves too large to ever be a real trade,
    whether or not the price reverts afterward (unlike flag_bad_prints, which requires
    reversion on both sides). Does NOT reset is_suspect first -- runs after flag_bad_prints
    in run() and adds to what it already flagged, rather than overwriting it."""
    actions_rows = conn.execute("SELECT symbol, ex_date FROM corporate_actions").fetchall()
    action_map = {}
    for r in actions_rows:
        sym = r[0] if isinstance(r, (list, tuple)) else r['symbol']
        dt  = str(r[1] if isinstance(r, (list, tuple)) else r['ex_date'])[:10]
        action_map.setdefault(sym, []).append(dt)

    bars_rows = conn.execute("SELECT symbol, date, close FROM stock_ohlcv ORDER BY symbol, date").fetchall()
    bars_map = {}
    for r in bars_rows:
        sym = r[0] if isinstance(r, (list, tuple)) else r['symbol']
        dt  = str(r[1] if isinstance(r, (list, tuple)) else r['date'])[:10]
        c   = float(r[2] if isinstance(r, (list, tuple)) else r['close'] or 0)
        bars_map.setdefault(sym, []).append((dt, c))

    suspects_to_update = []
    for sym, bars in bars_map.items():
        if len(bars) < 2:
            continue
        action_dates = action_map.get(sym, [])
        for i in range(1, len(bars)):
            d, c = bars[i]
            prev_close = bars[i - 1][1]
            if prev_close <= 0 or c is None or c < 0:
                continue
            dev = abs(c - prev_close) / prev_close
            if dev > threshold:
                near = any(_within(d, ad, action_window_days) for ad in action_dates)
                if not near:
                    suspects_to_update.append((sym, d))

    print(f"[OHLCVQuality] Flagging {len(suspects_to_update)} extreme-level-shift bars in database...")
    if suspects_to_update:
        conn.executemany(
            "UPDATE stock_ohlcv SET is_suspect=1 WHERE symbol=? AND date=?",
            suspects_to_update
        )
    conn.commit()

    print(f"[OHLCVQuality] flagged {len(suspects_to_update)} extreme-level-shift bars")
    return {'flagged': len(suspects_to_update)}


def flag_malformed_bars(conn: ConnWrapper) -> dict:
    """Mark bars that are internally impossible regardless of price history.

    flag_bad_prints/flag_extreme_level_shifts both reason about a bar RELATIVE to its
    neighbours, so neither catches a bar that is self-inconsistent: close outside
    [low, high], or a non-positive price. The live DB had 115 of the former and 84 of the
    latter, and a non-positive close produces an infinite return the moment anything
    computes a percentage change off it.

    Like flag_extreme_level_shifts, this ADDS to what is already flagged and must not reset
    -- flag_bad_prints owns the reset at the top of run().
    """
    rows = conn.execute("""
        SELECT symbol, date FROM stock_ohlcv
        WHERE close > high OR close < low OR open > high OR open < low OR high < low
           OR close <= 0 OR open <= 0 OR high <= 0 OR low <= 0
    """).fetchall()
    if rows:
        safe_keyed_update(
            conn,
            "UPDATE stock_ohlcv SET is_suspect=1 WHERE symbol=? AND date=?",
            [(r[0], r[1]) for r in rows])
    print(f"[OHLCVQuality] flagged {len(rows)} malformed bars (OHLC inconsistent / non-positive)")
    return {'flagged': len(rows)}


def run(ingest: bool = True, force_ingest: bool = False):
    conn = connect()
    try:
        if ingest:
            symbols = [r[0] for r in conn.execute("SELECT DISTINCT symbol FROM stock_ohlcv").fetchall()]
            ingest_corporate_actions(conn, symbols, force=force_ingest)
        flag_bad_prints(conn)          # owns the reset
        flag_extreme_level_shifts(conn)
        flag_malformed_bars(conn)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-ingest', action='store_true')
    parser.add_argument('--force-ingest', action='store_true',
                        help='Re-check every symbol\'s corporate actions even if checked '
                             f'within the last {CORPORATE_ACTIONS_STALENESS_DAYS} days')
    args = parser.parse_args()
    run(ingest=not args.no_ingest, force_ingest=args.force_ingest)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
