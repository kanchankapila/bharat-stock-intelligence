"""Grade the stop / target / valid_until the ranker PUBLISHED on every Buy (AF-20261008-02).

No writer puts ranker picks in `unified_signals`, so nothing ever checked whether a published
plan hits its target or its stop. This replays each plan on `stock_ohlcv` with the lifecycle
closer's own rules (`signal_lifecycle.close_swing`: first touch wins, a bar touching both is a
stop, a gap fills at the open), entering at the OPEN of the entry session -- `computed_at` is the
session the grid is FOR -- and holding for the plan's own `valid_until` horizon. Net of the
platform's round-trip cost. Read-only; it writes nothing and adds no table.

A control re-runs the same stop/target ATR multiples on random OTHER symbols the same session,
because a net return alone cannot say whether the picks or merely the geometry lost money.
Overlapping dates and no liquidity floor: a shape, not an edge claim (see measurement.md).

    python src/server/plan_outcome_report.py [--since 2026-08-01] [--classes Buy,"Strong Buy"]
"""
import argparse
import bisect
import os
import random
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from outcome_resolver import ROUND_TRIP_COST_PCT as COST  # noqa: E402
from signal_lifecycle import close_swing  # noqa: E402
from unified_ranker import HORIZON_SESSIONS  # noqa: E402


def plan_valid_at_open(entry, stop, target):
    """A plan whose entry open is already through its stop or target is not a trade."""
    if entry is None or stop is None or target is None:
        return False
    return stop < entry < target


def scale_levels(entry, stop, target, stop_scale=1.0, target_scale=1.0):
    """Re-place a plan's stop and target at a multiple of their published distance from entry."""
    return entry - (entry - stop) * stop_scale, entry + (target - entry) * target_scale


def grade_plan(bars, entry, stop, target, window_complete):
    """bars: [(date, open, high, low, close)] for the holding window, entry session first.
    Returns (outcome, net_return_pct) or None while the window is still running."""
    r = close_swing(bars, entry, target, stop, window_complete)
    if r is None:
        return None
    _, _, exit_px, reason = r
    if exit_px is None:
        return None
    outcome = {'TARGET': 'TARGET', 'STOP': 'STOP'}.get(reason, 'TIME')
    return outcome, (exit_px / entry - 1) * 100 - COST


def _atr_pct(bars_by_day, sessions, day, n=14):
    i0 = bisect.bisect_left(sessions, day)
    prev = [d for d in sessions[max(0, i0 - n - 1):i0] if d in bars_by_day]
    if len(prev) < n:
        return None
    trs = []
    for a, b in zip(prev, prev[1:]):
        pc = bars_by_day[a][3]
        _, h, l, _ = bars_by_day[b]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)) / pc)
    return sum(trs) / len(trs)


def _window(bars_by_day, sessions, day, h):
    i0 = bisect.bisect_left(sessions, day)
    win = sessions[i0:i0 + h]
    complete = len(win) == h
    rows = [(d,) + bars_by_day[d] for d in win if d in bars_by_day]
    return rows, complete


def _summarise(label, results):
    res = [r for r in results if r]
    if not res:
        return f'{label:30s} n=0'
    n = len(res)
    share = lambda k: sum(1 for o, _ in res if o == k) / n  # noqa: E731
    return (f'{label:30s} n={n:5d} target={share("TARGET"):5.1%} stop={share("STOP"):5.1%} '
            f'time={share("TIME"):5.1%} net={sum(r for _, r in res) / n:+.3f}%')


def run(conn, since, classes, seed=7, controls=5, stop_scale=1.0, target_scale=1.0):
    rnd = random.Random(seed)
    picks = conn.execute("""
        SELECT DISTINCT symbol, computed_at::text, upper(timeframe), stop_loss, target_1, entry_zone_low,
               entry_zone_high
        FROM unified_recommendations
        WHERE classification IN ({marks}) AND stop_loss IS NOT NULL AND target_1 IS NOT NULL
          AND timeframe IS NOT NULL AND computed_at::text >= ?
    """.format(marks=','.join('?' * len(classes))), (*classes, since)).fetchall()
    sessions = [str(r[0]) for r in conn.execute(
        "SELECT DISTINCT date FROM stock_ohlcv WHERE date >= CAST(? AS date) - 30 ORDER BY 1", (since,)).fetchall()]
    bars = defaultdict(dict)
    for s, d, o, h, l, c in conn.execute(
            "SELECT symbol, date, open, high, low, close FROM stock_ohlcv "
            "WHERE date >= CAST(? AS date) - 30 AND COALESCE(is_suspect, 0) = 0", (since,)).fetchall():
        bars[s][str(d)] = (float(o), float(h), float(l), float(c))
    universe = list(bars)

    got, ctrl, invalid, total = defaultdict(list), defaultdict(list), defaultdict(int), defaultdict(int)
    for sym, day, tf, sl, t1, lo, hi in picks:
        h = HORIZON_SESSIONS.get(tf)
        day = day[:10]
        if not h or sym not in bars:
            continue
        i0 = bisect.bisect_left(sessions, day)
        if i0 >= len(sessions) or sessions[i0] not in bars[sym]:
            continue
        entry = bars[sym][sessions[i0]][0]
        total[tf] += 1
        if not plan_valid_at_open(entry, float(sl), float(t1)):
            invalid[tf] += 1
            continue
        sl, t1 = scale_levels(entry, float(sl), float(t1), stop_scale, target_scale)
        rows, complete = _window(bars[sym], sessions, day, h)
        r = grade_plan(rows, entry, sl, t1, complete)
        if r is None:
            continue
        got[tf].append(r)
        a0 = _atr_pct(bars[sym], sessions, day)
        if not a0:
            continue
        sm, tm = (entry - float(sl)) / entry / a0, (float(t1) - entry) / entry / a0
        for _ in range(controls):
            o = rnd.choice(universe)
            ao = _atr_pct(bars[o], sessions, day)
            rows_o, complete_o = _window(bars[o], sessions, day, h)
            if not ao or not rows_o:
                continue
            e_o = rows_o[0][1]
            cr = grade_plan(rows_o, e_o, e_o * (1 - sm * ao), e_o * (1 + tm * ao), complete_o)
            if cr:
                ctrl[tf].append(cr)

    lines = []
    for tf in HORIZON_SESSIONS:
        lines.append(_summarise(f'PICKS   {tf}', got[tf]))
        lines.append(_summarise(f'CONTROL {tf} (same ATR geom)', ctrl[tf]))
        lines.append(f'   plan already invalid at the entry open: {invalid[tf]}/{total[tf]}')
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--since', default='2026-08-01')
    ap.add_argument('--classes', default='Buy,Strong Buy')
    ap.add_argument('--stop-scale', type=float, default=1.0, help='what-if: stop distance multiple')
    ap.add_argument('--target-scale', type=float, default=1.0, help='what-if: target distance multiple')
    args = ap.parse_args()
    from db_compat import connect
    conn = connect()
    try:
        print(run(conn, args.since, [c.strip() for c in args.classes.split(',')],
                  stop_scale=args.stop_scale, target_scale=args.target_scale))
    finally:
        conn.close()


if __name__ == '__main__':
    main()
