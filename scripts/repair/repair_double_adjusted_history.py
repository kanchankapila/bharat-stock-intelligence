"""AF-20261112-12: undo a split/bonus factor applied twice to stock_ohlcv bars.

repair_unadjusted_splits.py's 2026-10-10 run multiplied history that was already on the new basis
(an adjusted backfill meeting raw appended bars far from the ex-date, TRENT at 2025-05-12) by the
factor again. For each NAMED symbol a bar is corrected only when its stored close over its raw
bhavcopy close (nse_universe_history, EQ) equals the expected basis -- the product of every later
factor in ohlcv_adjustment_factors -- times ONE extra later factor f, within RAW_TOL, and only if at
least MIN_BARS bars match. Those bars get open/high/low/close / f and volume x f. A bar without a
raw close, or matching nothing, is left alone, and a second run finds nothing.

    python scripts/repair/repair_double_adjusted_history.py --symbols TRENT,DBEIL           # dry-run
    python scripts/repair/repair_double_adjusted_history.py --symbols ... --apply --dump-path stock_ohlcv.dump
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from repair_unadjusted_splits import RAW_TOL, _COUNT, _UPDATE_FROM, _d, _raw_closes, _series  # noqa: E402

MIN_BARS = 20   # a handful of stray matches is a coincidence, not a doubled segment


def corrections(series, raw, factors):
    """series: [(date, o, h, l, close, volume)]; raw: {date: close}; factors: [(ex_date, factor)].
    Returns {date: multiplier} that removes one extra application, or {} below MIN_BARS."""
    out = {}
    for b in series:
        rc = raw.get(b[0])
        if not rc or not b[4]:
            continue
        later = [f for ex, f in factors if ex > b[0]]
        rel = b[4] / (rc * math.prod(later))
        if abs(rel - 1) <= RAW_TOL:
            continue
        for f in sorted(set(later)):
            if abs(rel / f - 1) <= RAW_TOL:
                out[b[0]] = 1 / f
                break
    return out if len(out) >= MIN_BARS else {}


def plan(conn, symbols):
    conn.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0")
    ops, notes = [], ["symbol       bars  from        to          multipliers"]
    for sym in symbols:
        factors = [(_d(r[0]), float(r[1])) for r in conn.execute(
            "SELECT ex_date, factor FROM ohlcv_adjustment_factors WHERE symbol = ? ORDER BY ex_date",
            (sym,)).fetchall()]
        m = corrections(_series(conn, sym), _raw_closes(conn, sym), factors)
        if not m:
            notes.append(f"{sym:12s}    0  (nothing matches one extra factor)")
            continue
        ds = sorted(m)
        mults = ", ".join(f"{v:.4g}x{sum(1 for x in m.values() if x == v)}" for v in sorted(set(m.values())))
        notes.append(f"{sym:12s} {len(ds):5d}  {ds[0]}  {ds[-1]}  {mults}")
        ops.append(Op(f"stock_ohlcv[{sym}]", "update", _COUNT,
                      "UPDATE stock_ohlcv o SET open = o.open * v.m, high = o.high * v.m, "
                      "low = o.low * v.m, close = o.close * v.m, "
                      f"volume = round(o.volume / v.m)::bigint {_UPDATE_FROM}",
                      ([d.isoformat() for d in ds], [m[d] for d in ds], sym)))
    return ops, notes


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--symbols", required=True, help="comma-separated NSE symbols, each verified first")
    args = ap.parse_args(argv)
    syms = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    return run(args, conn, lambda c: plan(c, syms))


if __name__ == "__main__":
    sys.exit(main())
