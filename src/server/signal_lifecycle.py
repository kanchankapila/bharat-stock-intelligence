#!/usr/bin/env python3
"""Close published unified_signals: ACTIVE -> COMPLETED (target) / FAILED (stop) / EXPIRED (time).

Until 2026-10-01 nothing did this (AF-20261001-37). signals.ts's updateSignalAccuracy, the only
closer, had no caller; COMPLETED/FAILED came from one-off manual backfills with no validity
window, and 90,755 technical signals sat ACTIVE back to June -- shown as live to every reader.

Every signal now has a validity window in TRADING SESSIONS after the signal, by source
(`unified_signals.horizon_sessions`, stamped here):
  screener        0   the Trendlyne INTRADAY scan: closes inside its own session, on 15m bars
                      strictly after signal_generated_at; no touch -> square-off at the last bar
  technical_scan  5   recommendation_log carries the same signals at horizon_days = 5
  everything else 15  ATR swing levels (technical, AI) and platform/createSignal's 15-day horizon
The first level touched decides (published levels, not re-based); a bar that touches both is a
stop (the path inside a bar is unknown -- booking the win would inflate every rate); a bar that
opens through a level fills at its open. No touch by the window's last session -> EXPIRED at its
close. A window that has not finished stays ACTIVE. Win rates are NOT computed from this status:
outcome_resolver grades the same signals in unified_signal_outcomes with costs; this is the
lifecycle a reader sees.

Run: python signal_lifecycle.py [--dry-run]
"""
import bisect
from collections import defaultdict
from datetime import datetime, timedelta

from db_compat import connect
from intraday_outcome_resolver import _load_bars, paper_trade

HORIZON_SESSIONS = {'screener': 0, 'technical_scan': 5}
DEFAULT_HORIZON = 15


def horizon_for(source: str) -> int:
    return HORIZON_SESSIONS.get(source, DEFAULT_HORIZON)


def _is_long(entry, target, stop):
    if target is not None and stop is not None and target != stop:
        return target > stop
    if stop is not None and entry:
        return stop < entry
    if target is not None and entry:
        return target > entry
    return None


def close_swing(bars, entry, target, stop, window_complete):
    """bars: [(date, open, high, low, close)] for the window's sessions, chronological.
    Returns (status, closed_at, exit_price, exit_reason) or None while still open."""
    long = _is_long(entry, target, stop)
    for d, o, h, l, c in bars:
        if long is not None and stop is not None:
            if (l <= stop) if long else (h >= stop):
                gapped = (o <= stop) if long else (o >= stop)
                return 'FAILED', d, o if gapped else stop, 'STOP'
        if long is not None and target is not None:
            if (h >= target) if long else (l <= target):
                gapped = (o >= target) if long else (o <= target)
                return 'COMPLETED', d, o if gapped else target, 'TARGET'
    if not window_complete:
        return None
    if not bars:
        return 'EXPIRED', None, None, 'NO_BARS'
    return 'EXPIRED', bars[-1][0], bars[-1][4], 'TIME_EXIT'


def _close_intraday(fwd, target, stop, daily_close, entry):
    """fwd: 15m (ts, o, h, l, c) bars strictly after the signal, same session."""
    long = _is_long(entry, target, stop)
    if fwd and long is not None and target is not None and stop is not None:
        exit_p, reason, _, _ = paper_trade(fwd[0][1], target, stop,
                                           [b[1:] for b in fwd], 'LONG' if long else 'SHORT')
        status = {'STOP': 'FAILED', 'TARGET': 'COMPLETED'}.get(reason, 'EXPIRED')
        return status, exit_p, {'CLOSE': 'TIME_EXIT'}.get(reason, reason)
    if fwd:
        return 'EXPIRED', fwd[-1][4], 'TIME_EXIT'
    # No 15m bars after the signal: squared off at the session close; touches unknown.
    return 'EXPIRED', daily_close, 'TIME_EXIT_DAILY'


def run(conn, dry_run: bool = False) -> dict:
    rows = conn.execute("""
        SELECT id, symbol, (signal_date AT TIME ZONE 'Asia/Kolkata')::date AS sig_day,
               signal_generated_at, signal_source, entry_price, target_price, stop_loss
        FROM unified_signals WHERE status = 'ACTIVE'
    """).fetchall()
    counts = defaultdict(int)
    if rows:
        since = min(r[2] for r in rows)
        sessions = [str(r[0])[:10] for r in conn.execute(
            "SELECT DISTINCT date FROM stock_ohlcv WHERE date >= ? ORDER BY date", (since,)).fetchall()]
        bars = defaultdict(list)
        for s, d, o, h, l, c in conn.execute(
                "SELECT symbol, date, open, high, low, close FROM stock_ohlcv "
                "WHERE date >= ? AND symbol = ANY(?) AND COALESCE(is_suspect, 0) = 0 ORDER BY date",
                (since, list({r[1] for r in rows}))).fetchall():
            bars[s].append((str(d)[:10], float(o), float(h), float(l), float(c)))

        intraday = defaultdict(list)   # sig_day -> rows
        updates = []
        for rid, sym, sig_day, gen_at, source, entry, target, stop in rows:
            sig_day = str(sig_day)[:10]
            entry = float(entry) if entry is not None else None
            target = float(target) if target is not None else None
            stop = float(stop) if stop is not None else None
            h = horizon_for(source)
            if h == 0:
                if sessions and sessions[-1] > sig_day:     # that session is over
                    intraday[sig_day].append((rid, sym, gen_at, entry, target, stop))
                continue
            i0 = bisect.bisect_right(sessions, sig_day)
            window = set(sessions[i0:i0 + h])
            res = close_swing([b for b in bars[sym] if b[0] in window], entry, target, stop,
                              len(window) == h)
            if res:
                updates.append((res[0], res[1], res[2], res[3], h, rid))

        for day, recs in intraday.items():
            bars15 = _load_bars(conn, day, sorted({r[1] for r in recs}))
            for rid, sym, gen_at, entry, target, stop in recs:
                ts = gen_at if isinstance(gen_at, datetime) else datetime.fromisoformat(str(gen_at))
                fwd = [b for b in bars15.get(sym, []) if b[0] > ts]
                daily = next((b[4] for b in bars[sym] if b[0] == day), None)
                status, px, reason = _close_intraday(fwd, target, stop, daily, entry)
                updates.append((status, day, px, reason, 0, rid))

        for u in updates:
            counts[u[0]] += 1
        if dry_run:
            counts['rec_log_expired'] = expire_stale_recommendations(conn, dry_run=True)
            print(f"[signal-lifecycle] DRY RUN: would close {dict(counts)} of {len(rows)} active")
            return dict(counts)
        conn.executemany(
            "UPDATE unified_signals SET status = ?, closed_at = ?, exit_price = ?, exit_reason = ?, "
            "horizon_sessions = ? WHERE id = ? AND status = 'ACTIVE'", updates)
    for source, h in list(HORIZON_SESSIONS.items()) + [(None, DEFAULT_HORIZON)]:
        if source is None:
            conn.execute("UPDATE unified_signals SET horizon_sessions = ? WHERE horizon_sessions IS NULL "
                         "AND signal_source NOT IN ({})".format(",".join("?" * len(HORIZON_SESSIONS))),
                         (h, *HORIZON_SESSIONS))
        else:
            conn.execute("UPDATE unified_signals SET horizon_sessions = ? WHERE horizon_sessions IS NULL "
                         "AND signal_source = ?", (h, source))
    counts['rec_log_expired'] = expire_stale_recommendations(conn, dry_run)
    conn.commit()
    counts = dict(counts)
    print(f"[signal-lifecycle] {len(rows)} active examined; closed {counts}")
    return counts


def expire_stale_recommendations(conn, dry_run: bool = False) -> int:
    """recommendation_log rows whose horizon has elapsed but which never graded stay ACTIVE
    forever -- 21,638 of them on 2026-10-01, the oldest from 2026-05-18 at horizon 15, and
    trailingStopUpdater ratchets a stop on every one of them each run as if it were an open
    position. The cutoff per horizon is the h-th most recent SESSION in stock_ohlcv (never
    today - h days). EXPIRED does not block grading: the resolver selects on outcome, not
    status."""
    horizons = [int(r[0]) for r in conn.execute(
        "SELECT DISTINCT COALESCE(horizon_days, ?) FROM recommendation_log WHERE status = 'ACTIVE'",
        (DEFAULT_HORIZON,)).fetchall()]
    n = 0
    for h in sorted(horizons):
        sessions = [str(r[0])[:10] for r in conn.execute(
            "SELECT DISTINCT date FROM stock_ohlcv ORDER BY date DESC LIMIT ?", (h,)).fetchall()]
        if len(sessions) < h:
            continue
        cutoff = sessions[-1]           # h sessions have passed for anything before this date
        if dry_run:
            n += conn.execute(
                "SELECT COUNT(*) FROM recommendation_log WHERE status = 'ACTIVE' "
                "AND COALESCE(horizon_days, ?) = ? AND signal_date < ?",
                (DEFAULT_HORIZON, h, cutoff)).fetchone()[0]
            continue
        cur = conn.execute(
            "UPDATE recommendation_log SET status = 'EXPIRED' WHERE status = 'ACTIVE' "
            "AND COALESCE(horizon_days, ?) = ? AND signal_date < ?",
            (DEFAULT_HORIZON, h, cutoff))
        n += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    if dry_run:
        print(f"[signal-lifecycle] DRY RUN: would expire {n} stale ACTIVE recommendation_log rows")
    return n


if __name__ == '__main__':
    import sys
    c = connect()
    try:
        run(c, dry_run='--dry-run' in sys.argv)
    finally:
        c.close()
