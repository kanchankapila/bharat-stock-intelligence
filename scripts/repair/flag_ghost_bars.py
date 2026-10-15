"""Quarantine stock_ohlcv ghost bars on past sessions (same rule as the nightly reconcile).

A ghost bar is a stock_ohlcv row for a real NSE listing on a date whose official bhavcopy file is
complete but holds no row of any series for that symbol: the stock did not trade (halt,
suspension, record-date freeze) and the bar is a forward-filled copy (CCAVENUE 2026-10-13..15).
reconcile_stock_ohlcv_from_bhavcopy.ghost_bar_symbols() is the rule; this applies it to the last
N complete sessions. Flags only (is_suspect=1, suspect_reason=GHOST_REASON), never rewrites a bar;
one UPDATE per date whose predicate is that date plus the symbol list. Idempotent: rows already
carrying the flag are not candidates.

    python scripts/repair/flag_ghost_bars.py                    # dry-run, last 60 complete sessions
    python scripts/repair/flag_ghost_bars.py --sessions 120
    python scripts/repair/flag_ghost_bars.py --apply --dump-path stock_ohlcv.dump
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from reconcile_stock_ohlcv_from_bhavcopy import (  # noqa: E402
    COMPLETE_FILE_MIN_SYMBOLS, GHOST_REASON, ghost_bar_symbols)

SAMPLE = 15


def complete_sessions(conn, n: int) -> list[str]:
    rows = conn.execute(
        "SELECT date FROM nse_universe_history GROUP BY date "
        "HAVING count(DISTINCT symbol) >= ? ORDER BY date DESC LIMIT ?",
        (COMPLETE_FILE_MIN_SYMBOLS, n)).fetchall()
    return sorted(str(r[0])[:10] for r in rows)


def stale_evidence(conn, date: str, symbols: list[str]) -> dict[str, str]:
    """symbol -> 'same as <prev date>' when OHLCV equals the previous bar, else the diff."""
    out = {}
    for s in symbols:
        cur = conn.execute("SELECT open, high, low, close, volume FROM stock_ohlcv "
                           "WHERE symbol = ? AND date = ?", (s, date)).fetchone()
        prev = conn.execute("SELECT date, open, high, low, close, volume FROM stock_ohlcv "
                            "WHERE symbol = ? AND date < ? ORDER BY date DESC LIMIT 1",
                            (s, date)).fetchone()
        if prev is None:
            out[s] = "no previous bar"
            continue
        same = tuple(cur[i] for i in range(5)) == tuple(prev[i] for i in range(1, 6))
        out[s] = (f"{'SAME as' if same else 'differs from'} {str(prev[0])[:10]} "
                  f"(close {prev[4]} -> {cur[3]}, vol {prev[5]} -> {cur[4]})")
    return out


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--sessions", type=int, default=60)
    args = ap.parse_args(argv)

    def plan(conn):
        ops, notes, sample = [], [], []
        if args.apply:
            # Older chunks are compressed; the per-date symbol-list predicate keeps this narrow.
            conn.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0")
        for d in complete_sessions(conn, args.sessions):
            syms = ghost_bar_symbols(conn, d)
            if not syms:
                continue
            ev = stale_evidence(conn, d, syms)
            same = sum(1 for v in ev.values() if v.startswith("SAME"))
            notes.append(f"{d}: {len(syms)} ghost bar(s), {same} identical to the previous bar: "
                         + " ".join(syms))
            sample += [f"  {d} {s}: {ev[s]}" for s in syms]
            marks = ",".join("?" * len(syms))
            pred = f"WHERE date = ? AND symbol IN ({marks})"
            ops.append(Op(f"stock_ohlcv {d}", "flag",
                          f"SELECT count(*) FROM stock_ohlcv {pred}",
                          # count and write share params, so the constant reason is inlined
                          f"UPDATE stock_ohlcv SET is_suspect = 1, "
                          f"suspect_reason = '{GHOST_REASON}' {pred}",
                          (d, *syms)))
        if sample:
            step = max(1, len(sample) // SAMPLE)
            notes.append(f"sample ({min(SAMPLE, len(sample))} of {len(sample)}):")
            notes += sample[::step][:SAMPLE]
        return ops, notes
    return run(args, conn, plan)


if __name__ == "__main__":
    raise SystemExit(main())
