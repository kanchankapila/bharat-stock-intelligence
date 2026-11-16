"""AF-20261112-12: re-derive signal_excursions rows whose price window contains a bar that repair_single_bars.py
--sweep-bhavcopy replaced (high, low, close or volume changed). signal_excursions is the ml-ensemble training label
(tb_label), a path function of the bars after the signal date and the ATR before it.

Each row is judged by replaying exit_labeler.compute_excursions on the bars as they were BEFORE the sweep
(--pre-sweep-csv: the rollback CSV of the sweep) and comparing with the stored row:
  stored == replay on the old bars   the stored row was produced from the swept bars: replay on the current bars,
                                     update the row if it differs (the counted, guarded write)
  stored != replay on the old bars   the row was produced some other way (an older labeler, another price repair);
                                     left alone and counted, never overwritten
  stored == replay on the current    already repaired
computed_at is kept. The update only touches a row whose stored label fields still equal the reviewed ones.

    python scripts/repair/repair_excursions_after_sweep.py --pre-sweep-csv backups/stock_ohlcv_snapshot_bars_pre_20261115.csv
    ... --apply --dump-path bharat_intel.dump --rollback-csv backups/signal_excursions_pre_sweep_repair.csv
"""
from __future__ import annotations

import bisect
import csv
import datetime
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
import exit_labeler as X  # noqa: E402

PRIOR_BARS = X.ATR_WINDOW + X.VOL_RANK_LOOKBACK + 2
FIELDS = ["mfe_pct", "mae_pct", "days_to_mfe", "days_to_mae", "mfe_before_mae", "trail_exit_pct",
          "trail_exit_day", "horizon_close_pct", "atr_pct", "tb_label", "vol_rank"]
TOL = 5e-4
SYMBOL_CHUNK = 200


def same(a: dict, b: dict) -> bool:
    for k in FIELDS:
        x, y = a.get(k), b.get(k)
        if x is None or y is None:
            if x is not None or y is not None:
                return False
        elif abs(float(x) - float(y)) > TOL:
            return False
    return True


def replay(bars, signal_date: str, horizon: int, entry: float):
    """bars: ascending (date, high, low, close). exit_labeler's own window rules, or None for a short window."""
    dates = [b[0] for b in bars]
    i = bisect.bisect_right(dates, signal_date)
    fwd = bars[i:i + horizon]
    if len(fwd) < horizon:
        return None
    prior = [(b[1], b[2], b[3]) for b in bars[max(0, i - PRIOR_BARS):i]]
    return X.compute_excursions(float(entry), [(b[1], b[2], b[3]) for b in fwd], X.compute_atr(prior),
                                vol_rank=X.compute_vol_rank(prior)) or None


def load_swept(path):
    old = {}
    for r in csv.DictReader(open(path, newline="")):
        old[(r["symbol"], r["date"][:10])] = (float(r["high"]), float(r["low"]), float(r["close"]))
    return old


def plan(conn, csv_path, rollback_path=None):
    old = load_swept(csv_path)
    by_sym = defaultdict(set)
    for s, d in old:
        by_sym[s].add(d)
    dmin = min(d for _, d in old)
    bars_lo = (datetime.date.fromisoformat(dmin) - datetime.timedelta(days=200)).isoformat()
    sig_lo = (datetime.date.fromisoformat(dmin) - datetime.timedelta(days=60)).isoformat()
    syms = sorted(by_sym)
    cnt = Counter()
    flips = Counter()
    upd = []
    for c in range(0, len(syms), SYMBOL_CHUNK):
        chunk = syms[c:c + SYMBOL_CHUNK]
        new_bars = defaultdict(list)
        for r in conn.execute(
                "SELECT symbol, date::text, high, low, close FROM stock_ohlcv WHERE symbol = ANY(CAST(? AS text[])) "
                "AND date::text >= ? AND COALESCE(is_suspect, 0) = 0 ORDER BY symbol, date", (chunk, bars_lo)).fetchall():
            new_bars[r[0]].append((r[1][:10], r[2], r[3], r[4]))
        old_bars = {s: [(d,) + old.get((s, d), (h, lo, cl)) for d, h, lo, cl in b] for s, b in new_bars.items()}
        for r in conn.execute(
                "SELECT symbol, signal_date::text, horizon_days, entry_price, mfe_pct, mae_pct, days_to_mfe, days_to_mae, "
                "mfe_before_mae, trail_exit_pct, trail_exit_day, horizon_close_pct, atr_pct, tb_label, vol_rank "
                "FROM signal_excursions WHERE symbol = ANY(CAST(? AS text[])) AND signal_date::text >= ?",
                (chunk, sig_lo)).fetchall():
            r = tuple(r)
            s, sd, hd, entry = r[0], r[1][:10], int(r[2]), r[3]
            if not entry or s not in new_bars:
                continue
            dates = [b[0] for b in new_bars[s]]
            i = bisect.bisect_right(dates, sd)
            if not set(dates[max(0, i - PRIOR_BARS):i + hd]) & by_sym[s]:
                continue
            cnt["window touches a swept bar"] += 1
            stored = dict(zip(FIELDS, r[4:15]))
            a, b = replay(old_bars[s], sd, hd, entry), replay(new_bars[s], sd, hd, entry)
            if a is None or b is None:
                cnt["short window, left alone"] += 1
            elif not same(stored, a):
                cnt["not reproducible from the old bars, left alone"] += 1
            elif same(stored, b):
                cnt["same on old and current bars (sweep changed nothing material)"] += 1
            else:
                upd.append((s, sd, hd, stored, b))
                if stored["tb_label"] != b["tb_label"]:
                    flips[(stored["tb_label"], b["tb_label"])] += 1
    notes = [f"{k}: {v}" for k, v in sorted(cnt.items())]
    notes.append(f"to update: {len(upd)} rows, tb_label changes {sum(flips.values())} {dict(flips) or ''}")
    if rollback_path and upd:
        with open(rollback_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["symbol", "signal_date", "horizon_days"] + FIELDS)
            for s, sd, hd, st, _ in upd:
                w.writerow([s, sd, hd] + [st[k] for k in FIELDS])
        notes.append(f"rollback CSV: {rollback_path} ({len(upd)} rows)")
    if not upd:
        return [], notes
    s_, d_, h_ = [u[0] for u in upd], [u[1] for u in upd], [u[2] for u in upd]
    arrays = [s_, d_, h_]
    view_cols = ["s text", "d text", "h bigint"]
    casts = ["text", "text", "bigint"]
    kinds = {"days_to_mfe": "bigint", "days_to_mae": "bigint", "mfe_before_mae": "bigint", "trail_exit_day": "bigint",
             "tb_label": "bigint"}
    for k in FIELDS:
        t = kinds.get(k, "float8")
        arrays.append([u[3][k] for u in upd])
        view_cols.append(f"o_{k} {t}")
        casts.append(t)
    for k in FIELDS:
        t = kinds.get(k, "float8")
        arrays.append([u[4].get(k) for u in upd])
        view_cols.append(f"n_{k} {t}")
        casts.append(t)
    names = [c.split()[0] for c in view_cols]
    view = ("(SELECT " + ", ".join(f"unnest(CAST(? AS {t}[])) AS {n}" for n, t in zip(names, casts)) + ") v")
    guard = " AND ".join(f"e.{k} IS NOT DISTINCT FROM v.o_{k}" for k in FIELDS)
    key = "e.symbol = v.s AND e.signal_date::text = v.d AND e.horizon_days = v.h"
    sets = ", ".join(f"{k} = v.n_{k}" for k in FIELDS)
    return [Op("signal_excursions", "update",
               f"SELECT count(*) FROM signal_excursions e JOIN {view} ON {key} WHERE {guard}",
               f"UPDATE signal_excursions e SET {sets} FROM {view} WHERE {key} AND {guard}",
               tuple(arrays))], notes


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--pre-sweep-csv", required=True, help="rollback CSV written before repair_single_bars --sweep-bhavcopy")
    ap.add_argument("--rollback-csv", help="write the stored pre-state of every row to be updated (required with --apply)")
    args = ap.parse_args(argv)
    if args.apply and not args.rollback_csv:
        ap.error("--apply requires --rollback-csv")
    return run(args, conn, lambda c: plan(c, args.pre_sweep_csv, args.rollback_csv))


if __name__ == "__main__":
    sys.exit(main())
