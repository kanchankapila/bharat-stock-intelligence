"""AF-20261112-12: fix stock_ohlcv bars that the bulk repairs cannot or must not touch.

--bhavcopy-bar SYMBOL:DATE        replace a PARTIAL-DAY SNAPSHOT with the official bhavcopy bar (nse_universe_history,
--sweep-bhavcopy FROM:TO          EQ preferred): high, low, close and volume from the official row, open kept.
                                  A snapshot taken before the session ended has a narrower range, a different close
                                  and about half the volume (2026-06-02: 1,014 bars, GOLDIAM close 434.60 against the
                                  official 424.45). --sweep-bhavcopy does it for every MATERIAL bar in a date range
                                  (close or range off by more than 0.5%, or volume off by more than 20%); Yahoo's
                                  habit of rounding volume (14,800,000 against 14,819,413) is left alone.
                                  Applied ONLY where the open equals the official open (so the bar is on the raw
                                  basis: a split-adjusted bar's open differs by the factor) and production's range
                                  lies inside the official one. reconcile_stock_ohlcv_from_bhavcopy.py for a past
                                  date would instead overwrite split-adjusted history with raw prices.
--rebase-phantom SYMBOL:FROM:TO:MULT
                                  a QUARANTINED bar (is_suspect=1, absent_from_official_bhavcopy: NSE did not trade
                                  that day) whose open/high/low sit on the old basis while its close is on the new
                                  one (CCAVENUE 2026-10-13..15 after a 10:1 consolidation): open, high, low x MULT and
                                  volume / MULT, close and the quarantine untouched. A bar whose close/open is not
                                  about MULT is left alone, so a second run changes nothing.
Quarantined bars are never swept.

    python scripts/repair/repair_single_bars.py --bhavcopy-bar GOLDIAM:2026-06-15 \\
        --sweep-bhavcopy 2026-01-01:2026-11-13 --rebase-phantom CCAVENUE:2026-10-13:2026-10-16:10   # dry-run
    ... --apply --dump-path stock_ohlcv.dump
"""
from __future__ import annotations

import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from repair_unadjusted_splits import _d  # noqa: E402

OPEN_TOL = 0.001         # production open must equal the official open within 0.1%: proof of the raw basis
RANGE_TOL = 0.001        # production high/low may not lie outside the official range by more than this
CLOSE_FLOOR = 0.005      # a sweep fixes a close or range off by more than 0.5% ...
VOLUME_FLOOR = 0.20      # ... or a volume off by more than 20%
PHANTOM_REASON = "absent_from_official_bhavcopy"
PHANTOM_BAND = 0.15      # close/open must sit within 15% of MULT to count as the mixed-basis signature


def bar_fix(prod, raw):
    """prod, raw = (open, high, low, close, volume). (high, low, close, volume) to write, or None."""
    if not prod or not raw or not raw[3] or raw[3] <= 0 or raw[4] is None or not raw[1] or not raw[2]:
        return None
    if not prod[0] or not raw[0] or abs(prod[0] / raw[0] - 1) > OPEN_TOL:
        return None                                  # not provably on the raw basis: never overwrite with raw
    if prod[1] > raw[1] * (1 + RANGE_TOL) or prod[2] < raw[2] * (1 - RANGE_TOL):
        return None                                  # wider than the official range: not a partial snapshot
    new = (float(raw[1]), float(raw[2]), float(raw[3]), int(raw[4]))
    same = (abs(prod[1] / new[0] - 1) < 1e-6 and abs(prod[2] / new[1] - 1) < 1e-6
            and abs(prod[3] / new[2] - 1) < 1e-6 and prod[4] == new[3])
    return None if same else new


def material(prod, raw) -> bool:
    off = lambda a, b: abs(a / b - 1) > CLOSE_FLOOR
    return bool(off(prod[3], raw[3]) or off(prod[1], raw[1]) or off(prod[2], raw[2])
                or (raw[4] and abs(prod[4] / raw[4] - 1) > VOLUME_FLOOR))


def rebase_phantom(row, mult) -> bool:
    """row = (open, high, low, close, volume, is_suspect, suspect_reason)."""
    o, _, _, c, _, sus, reason = row
    return bool(sus == 1 and reason == PHANTOM_REASON and o and c and o > 0 and c > 0
                and abs((c / o) / mult - 1) <= PHANTOM_BAND)


_VIEW = ("(SELECT unnest(CAST(? AS text[])) AS s, unnest(CAST(? AS float8[])) AS h, unnest(CAST(? AS float8[])) AS l, "
         "unnest(CAST(? AS float8[])) AS c, unnest(CAST(? AS bigint[])) AS vol) v")
_REBASE_VIEW = "(SELECT unnest(CAST(? AS date[])) AS d, unnest(CAST(? AS float8[])) AS m) v"
_ROW_RAW = ("SELECT DISTINCT ON (date) open, high, low, close, volume FROM nse_universe_history "
            "WHERE symbol = ? AND date = ? AND close > 0 ORDER BY date, (series = 'EQ') DESC")


def _bars_op(day, fixes):
    syms, hs, ls, cs, vs = ([f[i] for f in fixes] for i in range(5))
    return Op(f"stock_ohlcv[bars {day}]", "update",
              f"SELECT count(*) FROM stock_ohlcv o JOIN {_VIEW} ON o.symbol = v.s WHERE o.date = ?",
              f"UPDATE stock_ohlcv o SET high = v.h, low = v.l, close = v.c, volume = v.vol FROM {_VIEW} "
              "WHERE o.symbol = v.s AND o.date = ?",
              (syms, hs, ls, cs, vs, day))


def plan(conn, bars, sweeps, phantoms):
    conn.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0")
    ops, notes, fixes = [], [], defaultdict(dict)
    for sym, d in bars:
        prod = conn.execute("SELECT open, high, low, close, volume FROM stock_ohlcv WHERE symbol = ? AND date = ?",
                            (sym, d)).fetchone()
        raw = conn.execute(_ROW_RAW, (sym, d)).fetchone()
        new = bar_fix(tuple(prod) if prod else None, tuple(raw) if raw else None)
        why = ("no stock_ohlcv bar" if not prod else "no official bar" if not raw else
               "already equal, or not provably a raw-basis partial snapshot")
        notes.append(f"{sym:10s} {d}  bar: " + (f"close {prod[3]} -> {new[2]}, volume {prod[4]} -> {new[3]}" if new
                                                  else f"nothing to do ({why})"))
        if new:
            fixes[d][sym] = (sym, *new)
    for d1, d2 in sweeps:
        rows = conn.execute(
            "SELECT o.date, o.symbol, o.open, o.high, o.low, o.close, o.volume, n.open, n.high, n.low, n.close, n.volume "
            "FROM stock_ohlcv o JOIN (SELECT DISTINCT ON (symbol, date) * FROM nse_universe_history WHERE close > 0 "
            "AND date BETWEEN ? AND ? ORDER BY symbol, date, (series = 'EQ') DESC) n ON n.symbol = o.symbol AND n.date = o.date "
            "WHERE o.date BETWEEN ? AND ? AND COALESCE(o.is_suspect, 0) = 0 AND o.close > 0 AND o.open > 0",
            (d1, d2, d1, d2)).fetchall()
        found = refused = 0
        for r in rows:
            prod, raw = (r[2], r[3], r[4], r[5], r[6]), (r[7], r[8], r[9], r[10], r[11])
            if not material(prod, raw):
                continue
            new = bar_fix(prod, raw)
            if new is None:
                refused += 1
            else:
                fixes[_d(r[0]).isoformat()][r[1]] = (r[1], *new)
                found += 1
        notes.append(f"sweep {d1}..{d2}: {found} material partial-snapshot bars to fix, {refused} material bars "
                     "refused (not provably raw basis, or wider than the official range)")
    for day in sorted(fixes):
        ops.append(_bars_op(day, list(fixes[day].values())))
    for sym, d1, d2, mult in phantoms:
        rows = conn.execute("SELECT date, open, high, low, close, volume, is_suspect, suspect_reason FROM stock_ohlcv "
                            "WHERE symbol = ? AND date BETWEEN ? AND ? ORDER BY date", (sym, d1, d2)).fetchall()
        hit = [_d(r[0]) for r in rows if rebase_phantom((r[1], r[2], r[3], r[4], r[5], r[6], r[7]), mult)]
        notes.append(f"{sym:10s} {d1}..{d2}  rebase phantom bars x{mult:g}: {[str(x) for x in hit] or 'none'}")
        if hit:
            ops.append(Op(f"stock_ohlcv[{sym} phantom]", "update",
                          f"SELECT count(*) FROM stock_ohlcv o JOIN {_REBASE_VIEW} ON o.date = v.d WHERE o.symbol = ?",
                          "UPDATE stock_ohlcv o SET open = o.open * v.m, high = o.high * v.m, low = o.low * v.m, "
                          f"volume = round(o.volume / v.m)::bigint FROM {_REBASE_VIEW} WHERE o.symbol = ? AND o.date = v.d",
                          ([x.isoformat() for x in hit], [mult] * len(hit), sym)))
    return ops, notes


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--bhavcopy-bar", action="append", default=[], metavar="SYMBOL:YYYY-MM-DD")
    ap.add_argument("--sweep-bhavcopy", action="append", default=[], metavar="FROM:TO")
    ap.add_argument("--rebase-phantom", action="append", default=[], metavar="SYMBOL:FROM:TO:MULT")
    args = ap.parse_args(argv)
    bars = [(a.split(":")[0].upper(), a.split(":")[1]) for a in args.bhavcopy_bar]
    sweeps = [tuple(a.split(":")) for a in args.sweep_bhavcopy]
    phantoms = []
    for a in args.rebase_phantom:
        s, d1, d2, m = a.split(":")
        phantoms.append((s.upper(), d1, d2, float(m)))
    if not (bars or sweeps or phantoms):
        ap.error("give at least one of --bhavcopy-bar, --sweep-bhavcopy, --rebase-phantom")
    return run(args, conn, lambda c: plan(c, bars, sweeps, phantoms))


if __name__ == "__main__":
    sys.exit(main())
