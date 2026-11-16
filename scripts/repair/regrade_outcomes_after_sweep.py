"""AF-20261112-12: re-grade signal_outcomes and unified_signal_outcomes rows whose holding window holds a bar that
repair_single_bars.py --sweep-bhavcopy replaced, using the resolver's OWN grading (outcome_resolver
_resolve_outcomes_batch / _resolve_unified_batch with `keys=` and `sink=`), never a reimplementation.

Each candidate row is graded twice, on the same connection:
  1. on the current bars                          -> the corrected result
  2. on the bars as they were before the sweep    -> the control: a temp table shadows stock_ohlcv with the sweep's
                                                     rollback CSV overlaid, so the resolver sees the snapshot bars
A row is updated only if the control reproduces the STORED row (the stored grade really came from the swept bars)
and the corrected result differs. Rows the control cannot reproduce (graded under an older definition, or from other
inputs) are left alone and counted. A row whose corrected result is PENDING is left alone. computed_at is kept, and the
UPDATE only touches a row whose stored fields still equal the reviewed ones.

    python scripts/repair/regrade_outcomes_after_sweep.py --pre-sweep-csv backups/stock_ohlcv_snapshot_bars_pre_20261115.csv
    ... --apply --dump-path bharat_intel.dump --rollback-prefix backups/outcomes_pre_sweep_repair_20261116
"""
from __future__ import annotations

import bisect
import contextlib
import csv
import datetime
import io
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
import outcome_resolver as R  # noqa: E402

LOOKBACK_DAYS = 45       # ATR (15 bars) and the volatility threshold (21 closes) read this far before the signal
CHUNK = 2000
STORED_OUTCOMES = "('WIN','LOSS','NEUTRAL','STOP_LOSS')"

# (field, index in the resolver's upsert parameters, kind: n number, d date, s text)
TECH_FIELDS = [("entry_price", 3, "n"), ("check_date", 4, "d"), ("exit_price", 5, "n"),
               ("return_pct", 6, "n"), ("outcome", 7, "s"), ("max_return_pct", 10, "n")]
UNI_FIELDS = [("entry_price", 5, "n"), ("check_date", 6, "d"), ("exit_price", 7, "n"), ("outcome", 8, "s"),
              ("return_pct", 9, "n"), ("exit_reason", 10, "s"), ("intraday_max_return_pct", 12, "n"),
              ("intraday_min_return_pct", 13, "n")]


def field_same(kind, x, y) -> bool:
    if x is None or y is None:
        return x is None and y is None
    if kind == "n":
        return abs(float(x) - float(y)) <= 1e-4 + 1e-6 * abs(float(y))
    return str(x)[:10] == str(y)[:10] if kind == "d" else str(x) == str(y)


def row_same(fields, stored: dict, params) -> bool:
    return all(field_same(k, stored[n], params[i]) for n, i, k in fields)


def load_swept(path):
    old = {}
    for r in csv.DictReader(open(path, newline="")):
        old[(r["symbol"], r["date"][:10])] = (float(r["high"]), float(r["low"]), float(r["close"]), int(float(r["volume"])))
    return old


def _touches(swept_by_sym, sym, signal_date, check_date) -> bool:
    ds = swept_by_sym.get(sym)
    if not ds:
        return False
    lo = (datetime.date.fromisoformat(signal_date) - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    hi = check_date or (datetime.date.fromisoformat(signal_date) + datetime.timedelta(days=60)).isoformat()
    i = bisect.bisect_left(ds, lo)
    return i < len(ds) and ds[i] <= hi


def candidates(conn, swept_by_sym, dmin):
    """-> (technical rows, unified rows) whose grading window holds a swept bar; each row is a dict."""
    sig_lo = (datetime.date.fromisoformat(dmin) - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    syms = sorted(swept_by_sym)
    tech, uni = [], []
    for c in range(0, len(syms), 200):
        chunk = syms[c:c + 200]
        for r in conn.execute(
                "SELECT symbol, signal_date::text, horizon_days, entry_price, check_date::text, exit_price, return_pct, "
                "outcome, max_return_pct FROM signal_outcomes WHERE signal_source = 'technical' "
                f"AND outcome IN {STORED_OUTCOMES} AND symbol = ANY(CAST(? AS text[])) AND signal_date::text >= ?",
                (chunk, sig_lo)).fetchall():
            r = tuple(r)
            if _touches(swept_by_sym, r[0], r[1][:10], r[4][:10] if r[4] else None):
                tech.append(dict(zip(["symbol", "signal_date", "horizon", "entry_price", "check_date", "exit_price",
                                      "return_pct", "outcome", "max_return_pct"], (r[0], r[1][:10], int(r[2])) + r[3:])))
        for r in conn.execute(
                "SELECT unified_signal_id, symbol, signal_date::text, horizon_days, entry_price, check_date::text, exit_price, "
                "outcome, return_pct, exit_reason, intraday_max_return_pct, intraday_min_return_pct "
                f"FROM unified_signal_outcomes WHERE outcome IN {STORED_OUTCOMES} AND symbol = ANY(CAST(? AS text[])) "
                "AND signal_date::text >= ?", (chunk, sig_lo)).fetchall():
            r = tuple(r)
            if _touches(swept_by_sym, r[1], r[2][:10], r[5][:10] if r[5] else None):
                uni.append(dict(zip(["id", "symbol", "signal_date", "horizon", "entry_price", "check_date", "exit_price",
                                     "outcome", "return_pct", "exit_reason", "intraday_max_return_pct",
                                     "intraday_min_return_pct"], (r[0], r[1], r[2][:10], int(r[3])) + r[4:])))
    return tech, uni


def grade(conn, tech, uni):
    """The resolver's own grading of exactly these rows -> ({tech key: params}, {uni key: params})."""
    t_out, u_out = {}, {}
    by_h = defaultdict(list)
    for r in tech:
        by_h[r["horizon"]].append((r["symbol"], r["signal_date"]))
    for h, keys in by_h.items():
        for i in range(0, len(keys), CHUNK):
            sink = []
            with contextlib.redirect_stdout(io.StringIO()):
                R._resolve_outcomes_batch(conn, horizon_days=h, keys=keys[i:i + CHUNK], sink=sink)
            for p in sink:
                t_out[(p[0], str(p[1])[:10], int(p[2]))] = p
            print(f"  graded technical h={h}: {min(i + CHUNK, len(keys))}/{len(keys)}", file=sys.stderr, flush=True)
    by_h = defaultdict(list)
    for r in uni:
        by_h[r["horizon"]].append(r["id"])
    for h, ids in by_h.items():
        for i in range(0, len(ids), CHUNK):
            sink = []
            with contextlib.redirect_stdout(io.StringIO()):
                R._resolve_unified_batch(conn, horizon_days=h, keys=ids[i:i + CHUNK], sink=sink)
            for p in sink:
                u_out[(int(p[0]), int(p[4]))] = p
            print(f"  graded unified h={h}: {min(i + CHUNK, len(ids))}/{len(ids)}", file=sys.stderr, flush=True)
    return t_out, u_out


def shadow_old_bars(conn, old, lo):
    """A temp stock_ohlcv holding the swept symbols' bars as they were before the sweep; it shadows the real table
    for unqualified names until drop_shadow()."""
    syms = sorted({s for s, _ in old})
    conn.execute("CREATE TEMP TABLE stock_ohlcv AS SELECT * FROM stock_ohlcv "
                 "WHERE symbol = ANY(CAST(? AS text[])) AND date >= CAST(? AS date)", (syms, lo))
    conn.execute("CREATE INDEX ON pg_temp.stock_ohlcv (symbol, date)")
    keys = sorted(old)
    conn.execute(
        "UPDATE pg_temp.stock_ohlcv o SET high = v.h, low = v.l, close = v.c, volume = v.vol FROM "
        "(SELECT unnest(CAST(? AS text[])) AS s, unnest(CAST(? AS text[])) AS d, unnest(CAST(? AS float8[])) AS h, "
        "unnest(CAST(? AS float8[])) AS l, unnest(CAST(? AS float8[])) AS c, unnest(CAST(? AS bigint[])) AS vol) v "
        "WHERE o.symbol = v.s AND CAST(o.date AS text) = v.d",
        ([k[0] for k in keys], [k[1] for k in keys], [old[k][0] for k in keys], [old[k][1] for k in keys],
         [old[k][2] for k in keys], [old[k][3] for k in keys]))
    conn.execute("ANALYZE pg_temp.stock_ohlcv")      # a temp table has no statistics: without this the grading queries scan it


def drop_shadow(conn):
    conn.execute("DROP TABLE IF EXISTS pg_temp.stock_ohlcv")


def _sorted_dates(old):
    by = defaultdict(list)
    for s, d in old:
        by[s].append(d)
    return {s: sorted(v) for s, v in by.items()}


def decide(stored_rows, fields, key_of, new, ctl, cnt, flips):
    """-> [(stored, new_params)] to update; counts into cnt/flips."""
    upd = []
    for r in stored_rows:
        k = key_of(r)
        n, c = new.get(k), ctl.get(k)
        if n is None or c is None:
            cnt["not gradable (no result)"] += 1
        elif not row_same(fields, r, c):
            cnt["not reproducible from the pre-sweep bars, left alone"] += 1
        elif n[7 if fields is TECH_FIELDS else 8] == "PENDING":
            cnt["regrade is PENDING, left alone"] += 1
        elif row_same(fields, r, n):
            cnt["same on old and current bars (sweep changed nothing material)"] += 1
        else:
            upd.append((r, n))
            if r["outcome"] != n[7 if fields is TECH_FIELDS else 8]:
                flips[(r["outcome"], n[7 if fields is TECH_FIELDS else 8])] += 1
    return upd


def _update_op(label, table, fields, key_names, key_sql, upd, rows_key_values):
    kinds = {"n": "float8", "d": "text", "s": "text"}
    arrays, cols, casts = [], [], []
    for name, vals, t in rows_key_values:
        arrays.append(vals); cols.append(name); casts.append(t)
    for n, i, k in fields:
        arrays.append([u[0][n] for u in upd]); cols.append(f"o_{n}"); casts.append(kinds[k])
    for n, i, k in fields:
        arrays.append([u[1][i] for u in upd]); cols.append(f"n_{n}"); casts.append(kinds[k])
    view = "(SELECT " + ", ".join(f"unnest(CAST(? AS {t}[])) AS {c}" for c, t in zip(cols, casts)) + ") v"
    guard = " AND ".join(
        (f"CAST(e.{n} AS text) IS NOT DISTINCT FROM v.o_{n}" if k == "d" else f"e.{n} IS NOT DISTINCT FROM v.o_{n}")
        for n, i, k in fields)
    sets = ", ".join(f"{n} = CAST(v.n_{n} AS date)" if k == "d" else f"{n} = v.n_{n}" for n, i, k in fields)
    return Op(label, "update",
              f"SELECT count(*) FROM {table} e JOIN {view} ON {key_sql} WHERE {guard}",
              f"UPDATE {table} e SET {sets} FROM {view} WHERE {key_sql} AND {guard}", tuple(arrays))


def write_rollback(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def plan(conn, csv_path, rollback_prefix=None):
    old = load_swept(csv_path)
    swept_by_sym = _sorted_dates(old)
    dmin = min(d for _, d in old)
    lo = (datetime.date.fromisoformat(dmin) - datetime.timedelta(days=120)).isoformat()
    tech, uni = candidates(conn, swept_by_sym, dmin)
    notes = [f"candidates whose grading window holds a swept bar: signal_outcomes {len(tech)}, unified_signal_outcomes {len(uni)}"]
    new_t, new_u = grade(conn, tech, uni)
    shadow_old_bars(conn, old, lo)
    try:
        ctl_t, ctl_u = grade(conn, tech, uni)
    finally:
        drop_shadow(conn)
    ops = []
    for label, table, fields, rows, new, ctl, key_of in (
            ("signal_outcomes", "signal_outcomes", TECH_FIELDS, tech, new_t, ctl_t,
             lambda r: (r["symbol"], r["signal_date"], r["horizon"])),
            ("unified_signal_outcomes", "unified_signal_outcomes", UNI_FIELDS, uni, new_u, ctl_u,
             lambda r: (r["id"], r["horizon"]))):
        cnt, flips = Counter(), Counter()
        upd = decide(rows, fields, key_of, new, ctl, cnt, flips)
        notes += [f"{label}: {k}: {v}" for k, v in sorted(cnt.items())]
        notes.append(f"{label}: to update {len(upd)} rows, outcome changes {sum(flips.values())} {dict(flips) or ''}")
        if rollback_prefix and upd:
            path = f"{rollback_prefix}_{label}.csv"
            keyc = ["symbol", "signal_date", "horizon"] if table == "signal_outcomes" else ["id", "symbol", "signal_date", "horizon"]
            write_rollback(path, keyc + [f[0] for f in fields], [[u[0][k] for k in keyc] + [u[0][f[0]] for f in fields] for u in upd])
            notes.append(f"rollback CSV: {path} ({len(upd)} rows)")
        if not upd:
            continue
        if table == "signal_outcomes":
            ops.append(_update_op(label, table, fields, None,
                                  "e.symbol = v.s AND CAST(e.signal_date AS text) = v.d AND e.horizon_days = v.h "
                                  "AND e.signal_source = 'technical'", upd,
                                  [("s", [u[0]["symbol"] for u in upd], "text"), ("d", [u[0]["signal_date"] for u in upd], "text"),
                                   ("h", [u[0]["horizon"] for u in upd], "bigint")]))
        else:
            ops.append(_update_op(label, table, fields, None,
                                  "e.unified_signal_id = v.i AND e.horizon_days = v.h", upd,
                                  [("i", [u[0]["id"] for u in upd], "bigint"), ("h", [u[0]["horizon"] for u in upd], "bigint")]))
    return ops, notes


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--pre-sweep-csv", required=True, help="rollback CSV written before repair_single_bars --sweep-bhavcopy")
    ap.add_argument("--rollback-prefix", help="write the stored pre-state of every row to update (required with --apply)")
    args = ap.parse_args(argv)
    if args.apply and not args.rollback_prefix:
        ap.error("--apply requires --rollback-prefix")
    return run(args, conn, lambda c: plan(c, args.pre_sweep_csv, args.rollback_prefix))


if __name__ == "__main__":
    sys.exit(main())
