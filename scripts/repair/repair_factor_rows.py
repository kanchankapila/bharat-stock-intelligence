"""AF-20261112-12: clean ohlcv_adjustment_factors from the reviewed TEJ plus raw-price arbitration
(research/out/tej-corporate-actions-validation-2026-11-15/tej_raw_arbiter.csv). Production prices no longer depend
on these rows (the price repair is applied); this makes the table itself correct so nothing re-derives from it.

Per arbiter verdict, and only while the stored row still equals the reviewed `our_factor`:
  SPURIOUS_NO_JUMP, NO_JUMP_NON_EQUITY_OR_SPURIOUS   DELETE (no price jump and no TEJ action: the action never reached price)
  CIRCUIT_BAND_ARTIFACT                               DELETE only if source = bhavcopy_prev_close and no corporate_actions
                                                      row within ohlcv_adjust.DECLARED_WINDOW_DAYS declares it
  TEJ_RIGHT, BOTH_PLAUSIBLE                           UPDATE to tej_factor, source 'tej_action'
  anything else (NEITHER, NO_RAW_BARS, OURS_RIGHT)    left alone
--insert SYMBOL:YYYY-MM-DD:FACTOR:SOURCE adds a verified row that is missing (ON CONFLICT DO NOTHING).

    python scripts/repair/repair_factor_rows.py --decisions research/out/.../tej_raw_arbiter.csv \\
        --insert CCAVENUE:2026-10-19:10:tej_action                       # dry-run
    ... --apply --dump-path ohlcv_adjustment_factors.dump
"""
from __future__ import annotations

import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from ohlcv_adjust import DECLARED_WINDOW_DAYS, _declared_near  # noqa: E402,F401

SAME = 1e-3
DELETE_ALWAYS = {"SPURIOUS_NO_JUMP", "NO_JUMP_NON_EQUITY_OR_SPURIOUS"}
UPDATE_TO_TEJ = {"TEJ_RIGHT", "BOTH_PLAUSIBLE"}
PRICE_DERIVED = "bhavcopy_prev_close"
NEW_SOURCE = "tej_action"


def decide(row, stored, declared):
    """row: arbiter csv row. stored: (factor, source) or None. -> ('delete'|'update'|'skip', value-or-reason)."""
    if stored is None:
        return "skip", "row no longer exists"
    ours = float(row["our_factor"])
    if abs(stored[0] / ours - 1) > SAME:
        return "skip", "stored factor changed since review"
    arb = row["arbiter"]
    if arb in DELETE_ALWAYS:
        return "delete", None
    if arb == "CIRCUIT_BAND_ARTIFACT":
        if stored[1] != PRICE_DERIVED:
            return "skip", f"source {stored[1]} declared it"
        if declared:
            return "skip", "a corporate action is declared near the date"
        return "delete", None
    if arb in UPDATE_TO_TEJ:
        tej = row.get("tej_factor")
        if tej in (None, ""):
            return "skip", "no confirmed factor"
        return "update", float(tej)
    return "skip", f"arbiter {arb} is not actionable"


_KEYS = "(SELECT unnest(CAST(? AS text[])) AS s, unnest(CAST(? AS text[])) AS d{extra}) v"


def plan(conn, csv_path, inserts):
    rows = list(csv.DictReader(open(csv_path, newline="")))
    declared: dict = {}
    for r in conn.execute("SELECT symbol, ex_date FROM corporate_actions WHERE action_type IN ('OTHER','SPLIT','BONUS')").fetchall():
        declared.setdefault(r[0], []).append(r[1])
    stored = {(r[0], str(r[1])[:10]): (r[2], r[3]) for r in conn.execute(
        "SELECT symbol, ex_date, factor, source FROM ohlcv_adjustment_factors").fetchall()}
    dels, upds, notes, skipped = [], [], [], {}
    for r in rows:
        k = (r["symbol"], r["ex_date"])
        verb, val = decide(r, stored.get(k), _declared_near(declared.get(r["symbol"]), r["ex_date"]))
        if verb == "delete":
            dels.append(k)
        elif verb == "update":
            upds.append((*k, val))
        else:
            skipped[val] = skipped.get(val, 0) + 1
    notes.append(f"{len(rows)} reviewed rows: {len(dels)} delete, {len(upds)} update, skipped {skipped or 'none'}")
    ops = []
    if dels:
        v = _KEYS.format(extra="")
        ops.append(Op("ohlcv_adjustment_factors", "delete",
                      f"SELECT count(*) FROM ohlcv_adjustment_factors f JOIN {v} ON f.symbol = v.s AND f.ex_date::text = v.d",
                      f"DELETE FROM ohlcv_adjustment_factors f USING {v} WHERE f.symbol = v.s AND f.ex_date::text = v.d",
                      ([d[0] for d in dels], [d[1] for d in dels])))
    if upds:
        v = _KEYS.format(extra=", unnest(CAST(? AS float8[])) AS x")
        ops.append(Op("ohlcv_adjustment_factors", "update",
                      f"SELECT count(*) FROM ohlcv_adjustment_factors f JOIN {v} ON f.symbol = v.s AND f.ex_date::text = v.d",
                      f"UPDATE ohlcv_adjustment_factors f SET factor = v.x, source = '{NEW_SOURCE}' FROM {v} "
                      "WHERE f.symbol = v.s AND f.ex_date::text = v.d",
                      ([u[0] for u in upds], [u[1] for u in upds], [u[2] for u in upds])))
    for sym, d, f, src in inserts:
        ops.append(Op("ohlcv_adjustment_factors", "insert",
                      "SELECT count(*) FROM (SELECT 1) t WHERE NOT EXISTS "
                      "(SELECT 1 FROM ohlcv_adjustment_factors WHERE symbol = ? AND ex_date::text = ?)",
                      f"INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor, source) VALUES (?, ?, {float(f)!r}, '{src}') "
                      "ON CONFLICT (symbol, ex_date) DO NOTHING",
                      (sym, d)))
        notes.append(f"insert {sym} {d} factor {f} source {src} (skipped if the row exists)")
    return ops, notes


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--decisions", required=True, help="tej_raw_arbiter.csv")
    ap.add_argument("--insert", action="append", default=[], metavar="SYMBOL:DATE:FACTOR:SOURCE")
    args = ap.parse_args(argv)
    inserts = []
    for a in args.insert:
        s, d, f, src = a.split(":")
        inserts.append((s.upper(), d, float(f), src))
    return run(args, conn, lambda c: plan(c, args.decisions, inserts))


if __name__ == "__main__":
    sys.exit(main())
