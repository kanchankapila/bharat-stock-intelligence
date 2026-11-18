"""AF-20261112-12: correct stock_ohlcv bars whose level disagrees with raw bhavcopy x TEJ's exact factors.

Truth for a bar = its raw NSE close (nse_universe_history, EQ) x the product of every TEJ split/bonus
factor whose ex-date is after the bar and not in the future (api.tejhq.dev/v1/actions/{symbol}: a bonus
is den/(num+den), a split is face_value_to/face_value_from, same-day actions multiply). A bar is
corrected only when truth/production equals a CLEAN ratio, meaning a product of TEJ factors (or one TEJ
factor over the factor ohlcv_adjustment_factors stored for the same date, which fixes a wrong stored
value), or its inverse, within RAW_TOL, and only as a CONTIGUOUS run of at least MIN_BARS bars. Steps
under MIN_STEP are dividend-sized basis differences, not corporate actions. Bars with no raw close, a
ratio that matches nothing, or a short run are left alone and counted. Named symbols only. Fixes the
cases the other repairs cannot: a consolidation whose seam lies outside the 5-day window
(CCAVENUE), a 20% action inside the circuit band (MINDTECK), an older segment that never got a later
factor (VRLLOG), a factor applied twice (KAPSTON), a wrong stored factor (NARMADA).

    python scripts/repair/repair_tej_truth.py --symbols CCAVENUE,NARMADA            # dry-run
    python scripts/repair/repair_tej_truth.py --symbols ... --apply --dump-path stock_ohlcv.dump
"""
from __future__ import annotations

import itertools
import math
import os
import sys
import time
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from repair_unadjusted_splits import RAW_TOL, _COUNT, _UPDATE_FROM, _d, _series  # noqa: E402

TEJ_URL = "https://api.tejhq.dev/v1/actions/{}"
MIN_BARS = 20       # a handful of matching bars is a coincidence, not a segment
MIN_STEP = 0.05     # |ln(multiplier)| below this is dividend-sized, not a corporate action
MAX_RATIOS = 8      # subsets of at most this many ratios are tried as candidate multipliers
BRIDGE_MAX = 15     # longest unverifiable hole filled between two runs of the same multiplier
STEP_ALERT = 0.25   # a bar-to-bar move above this that the correction would create blocks the symbol


def fetch_actions(symbol: str) -> dict:
    import requests
    r = requests.get(TEJ_URL.format(symbol), timeout=25)
    time.sleep(1.0)     # one request a second: the source is free and unauthenticated
    if r.status_code != 200:
        raise RuntimeError(f"TEJ answered HTTP {r.status_code} for {symbol}")
    return r.json()


def raw_closes(conn, symbol, aliases=()):
    """{date: raw bhavcopy close} for the symbol in ANY series (a stock moves between EQ and BE, and
    an EQ-only lookup misses those days), EQ preferred on a date. `aliases` are earlier tickers of the
    same company (CCAVENUE was INFIBEAM until 2026-02-02); the current symbol wins on a shared date."""
    out = {}
    for sym in (symbol, *aliases):
        for d, c in conn.execute(
                "SELECT DISTINCT ON (date) date, close FROM nse_universe_history WHERE symbol = ? AND close > 0 "
                "ORDER BY date, (series = 'EQ') DESC", (sym,)).fetchall():
            out.setdefault(_d(d), float(c))
    return out


def tej_factors(actions) -> list:
    """[(ex_date, factor)] ascending from TEJ action rows; rows without a usable ratio are skipped
    (a non-equity bonus such as TVSMOTOR's carries none) and BSE/NSE duplicates count once."""
    seen = {}
    for a in actions:
        t = a.get("type")
        if t == "bonus" and a.get("ratio_num") and a.get("ratio_den"):
            f = a["ratio_den"] / (a["ratio_num"] + a["ratio_den"])
        elif t == "split" and a.get("face_value_from") and a.get("face_value_to"):
            f = a["face_value_to"] / a["face_value_from"]
        else:
            continue
        seen[(a["ex_date"], t, a.get("ratio_num"), a.get("ratio_den"),
              a.get("face_value_from"), a.get("face_value_to"))] = f
    byd = {}
    for (d, *_), f in seen.items():
        byd[d] = byd.get(d, 1.0) * f
    return sorted((date.fromisoformat(d), f) for d, f in byd.items())


def merge_actions(tej, extras) -> list:
    """TEJ's [(ex_date, factor)] plus operator-supplied actions verified elsewhere (NSE's SME index
    lists SIKKO's 2021-03-18 1:1 bonus, TEJ does not); a supplied factor replaces TEJ's for that date."""
    byd = dict(tej)
    byd.update(dict(extras))
    return sorted(byd.items())


def _candidates(known, ours, min_step=MIN_STEP) -> list:
    ratios = []
    for ex, f in known:
        ratios.append(f)
        stored = [of for oex, of in ours if abs((oex - ex).days) <= 5]
        if stored and abs(stored[0] / f - 1) > 0.005:
            ratios.append(f / stored[0])        # corrects a wrong stored factor
    ratios = ratios[-MAX_RATIOS:]
    out = {}
    for n in range(1, len(ratios) + 1):
        for combo in itertools.combinations(ratios, n):
            p = math.prod(combo)
            for v in (p, 1 / p):
                if abs(math.log(v)) >= min_step:
                    out.setdefault(round(v, 6), v)
    return list(out.values())


def plan_symbol(series, raw, tej, ours, last, min_step=MIN_STEP):
    """series [(date, o, h, l, close, volume)]; raw {date: raw close}; tej and ours [(ex_date, factor)];
    last = the newest bar date, so an announced but not yet effective action is never applied.
    Returns ({date: multiplier}, {'segments': [...], 'unmatched': n})."""
    known = [(ex, f) for ex, f in tej if ex <= last]
    cands = _candidates(known, ours, min_step)
    labels = []
    for b in series:
        rc = raw.get(b[0])
        if not rc or not b[4] or b[4] <= 0:
            continue
        m = rc * math.prod(f for ex, f in known if ex > b[0]) / b[4]
        if abs(m - 1) <= RAW_TOL:
            labels.append((b[0], None))
            continue
        best = min(cands, key=lambda c: abs(math.log(m / c)), default=None)
        labels.append((b[0], best if best is not None and abs(m / best - 1) <= RAW_TOL else "x"))
    mult, segments, runs = {}, [], []
    for label, grp in itertools.groupby(labels, key=lambda t: t[1]):
        run_ = [d for d, _ in grp]
        if isinstance(label, float) and len(run_) >= MIN_BARS:
            mult.update({d: label for d in run_})
            runs.append((label, run_))
            segments.append({"from": run_[0], "to": run_[-1], "bars": len(run_), "multiplier": label})
    # A short hole between two runs of the SAME multiplier (bars with no raw close, or a raw close that
    # matches nothing) gets that multiplier too, or the segment would carry a fake seam inside it. Never
    # across a verified bar that needs something else, a long gap, or a price step in production.
    label_of, at = dict(labels), {b[0]: i for i, b in enumerate(series)}
    anchors, extra = sorted(mult, key=at.get), {}
    for a, c in zip(anchors, anchors[1:]):
        i, j = at[a], at[c]
        gap = series[i + 1:j]
        if not gap or len(gap) > BRIDGE_MAX or mult[a] != mult[c]:
            continue
        if any(b[0] in label_of and label_of[b[0]] != "x" for b in gap):
            continue
        closes = [series[k][4] for k in range(i, j + 1)]
        if any(not x or x <= 0 for x in closes) or any(not 0.7 <= closes[k + 1] / closes[k] <= 1.3 for k in range(len(closes) - 1)):
            continue
        extra.update({b[0]: mult[a] for b in gap})

    def edge(k, step, stop_before=None):
        """Walk outward from a segment end over bars with no verdict while production stays continuous."""
        out = []
        while 0 <= k < len(series) and len(out) < BRIDGE_MAX:
            b, prev = series[k], series[k - step]
            if (b[0] in label_of and label_of[b[0]] != "x") or (stop_before and b[0] >= stop_before):
                break
            later, earlier = (prev, b) if step < 0 else (b, prev)
            if not earlier[4] or not later[4] or earlier[4] <= 0 or later[4] <= 0 or not 0.7 <= later[4] / earlier[4] <= 1.3:
                break
            out.append(b[0])
            k += step
        return out

    if anchors:
        extra.update({d: mult[anchors[0]] for d in edge(at[anchors[0]] - 1, -1)})
        boundary = min((ex for ex, _ in known if ex > anchors[-1]), default=None)
        if boundary:     # only up to the next real action, where a production step is expected
            extra.update({d: mult[anchors[-1]] for d in edge(at[anchors[-1]] + 1, 1, boundary)})
    mult.update(extra)
    rep = {"segments": segments, "unmatched": sum(1 for _, l in labels if l == "x"), "bridged": len(extra), "review": []}

    # Final guard: a correction must not CREATE a price step. TEJ can miss an action (SIKKO's 1:1 on the
    # SME board, 2021-03-18), and then its "truth" is wrong for the bars before it; refuse the symbol.
    def big_steps(closes):
        return {series[i][0] for i in range(1, len(series))
                if closes[i - 1] and closes[i] and abs(closes[i] / closes[i - 1] - 1) > STEP_ALERT}
    new = sorted(big_steps([b[4] * mult.get(b[0], 1.0) for b in series]) - big_steps([b[4] for b in series]))
    if new:
        rep.update(review=new, bridged=0)
        return {}, rep
    return mult, rep


def plan(conn, symbols, aliases=None, extras=None, min_step=MIN_STEP):
    aliases, extras = aliases or {}, extras or {}
    conn.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0")
    ops, notes = [], []
    for sym in symbols:
        try:
            tej = merge_actions(tej_factors(fetch_actions(sym).get("data", [])), extras.get(sym, []))
        except Exception as e:      # a symbol TEJ cannot answer is skipped, never guessed
            notes.append(f"{sym:12s} SKIPPED: {e}")
            continue
        series = _series(conn, sym)
        if not series:
            notes.append(f"{sym:12s} SKIPPED: no stock_ohlcv bars")
            continue
        ours = [(_d(r[0]), float(r[1])) for r in conn.execute(
            "SELECT ex_date, factor FROM ohlcv_adjustment_factors WHERE symbol = ? ORDER BY ex_date",
            (sym,)).fetchall()]
        raw = raw_closes(conn, sym, aliases.get(sym, ()))
        mult, rep = plan_symbol(series, raw, tej, ours, series[-1][0], min_step)
        no_raw = sum(1 for b in series if b[0] not in raw)
        notes.append(f"{sym:12s} TEJ factors {[(str(e), round(f, 4)) for e, f in tej][-3:]}; "
                     f"{len(mult)} bars to correct (incl. {rep['bridged']} bridged), {rep['unmatched']} unmatched and "
                     f"{no_raw} without a raw close (of {len(series)}) not all touched")
        if rep["review"]:
            notes.append(f"{'':12s}   REVIEW, nothing applied: the plan would create a new price step at "
                         f"{[str(d) for d in rep['review'][:5]]} (TEJ may be missing an action)")
            continue
        for s in rep["segments"]:
            notes.append(f"{'':12s}   {s['from']} .. {s['to']}  {s['bars']:5d} bars  x{s['multiplier']:.6g}")
        if mult:
            ds = sorted(mult)
            ops.append(Op(f"stock_ohlcv[{sym}]", "update", _COUNT,
                          "UPDATE stock_ohlcv o SET open = o.open * v.m, high = o.high * v.m, "
                          "low = o.low * v.m, close = o.close * v.m, "
                          f"volume = round(o.volume / v.m)::bigint {_UPDATE_FROM}",
                          ([d.isoformat() for d in ds], [mult[d] for d in ds], sym)))
    return ops, notes


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--symbols", required=True, help="comma-separated NSE symbols, each checked against TEJ")
    ap.add_argument("--alias", action="append", default=[], metavar="NEW:OLD",
                    help="an earlier ticker of NEW whose raw closes should be used too, e.g. CCAVENUE:INFIBEAM")
    ap.add_argument("--extra-action", action="append", default=[], metavar="SYMBOL:YYYY-MM-DD:FACTOR",
                    help="an action verified at NSE that TEJ lacks, e.g. SIKKO:2021-03-18:0.5 (SME 1:1 bonus)")
    ap.add_argument("--min-step", type=float, default=MIN_STEP,
                    help="smallest correction applied; lower it only for named symbols whose factor two sources confirm")
    args = ap.parse_args(argv)
    syms = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    aliases: dict = {}
    for a in args.alias:
        new, _, old = a.upper().partition(":")
        aliases.setdefault(new, []).append(old)
    extras: dict = {}
    for a in args.extra_action:
        sym, d, f = a.split(":")
        extras.setdefault(sym.upper(), []).append((date.fromisoformat(d), float(f)))
    return run(args, conn, lambda c: plan(c, syms, aliases, extras, args.min_step))


if __name__ == "__main__":
    sys.exit(main())
