#!/usr/bin/env python3
"""Grade unified_ranker's blend components and alternative weight sets on realised returns.

Read-only. Produced the 2026-10-26 evidence for zeroing `breakout` (AF-20261026-44).

Panel: every stored `unified_recommendations` run, dated by `generated_at` in IST (never
`computed_at`, which lags one session -- measurement.md), graded on the NEXT session it could be
acted on:
    o2c1  next-session close/open - 1            (harvestable by an evening decision)
    r5    5th session's close / next open - 1     (a 5-session hold)
Returns are clipped at +/-40% (the repo's fixed-bound convention; never quantile clipping).

Arms replay the blend with blend_walkforward's EXACT mirrors of unified_ranker._normalize_to_100
and _blend on identical rows. Post-blend vetoes/multipliers are NOT replayed (the script prints
the BASE-vs-stored rank correlation so a reader sees that fidelity). Power: h=1 dates are
independent; for h=5 the t statistic uses every 5th date only (disjoint windows). Pre-registered
decision rule: an arm is credible only if its paired per-date IC delta over BASE is positive in
BOTH halves of the window.

    backend-python/venv/Scripts/python.exe scripts/measure_blend_arms.py
"""
import argparse
import math
import os
import sys

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src", "server"))
from blend_walkforward import _normalize_to_100_series, _blend_row  # noqa: E402
from unified_ranker import REGIME_WEIGHTS, ENGINE_TO_SCORE_COL  # noqa: E402

RIVALS = ("ml", "confluence", "technical")

# REGIME_WEIGHTS as they stood immediately before the 2026-10-26 breakout removal (d3fe4151), kept
# here so this script reproduces that decision after the live table changed: BASE = these,
# LIVE = unified_ranker.REGIME_WEIGHTS as imported.
PRE_2026_10_26 = {
    "BULL":     {"screener": 0.0, "ml": 0.184783, "cs": 0.0, "confluence": 0.369565, "technical": 0.295652, "dl": 0.0, "breakout": 0.15, "smart_money": 0.0},
    "BEAR":     {"screener": 0.0, "ml": 0.236786, "cs": 0.0, "confluence": 0.473574, "technical": 0.23964, "dl": 0.0, "breakout": 0.05, "smart_money": 0.0},
    "HIGH_VOL": {"screener": 0.0, "ml": 0.12857, "cs": 0.0, "confluence": 0.257143, "technical": 0.514287, "dl": 0.0, "breakout": 0.10, "smart_money": 0.0},
    "CRASH":    {"screener": 0.0, "ml": 0.267188, "cs": 0.0, "confluence": 0.415624, "technical": 0.267188, "dl": 0.0, "breakout": 0.05, "smart_money": 0.0},
    "SIDEWAYS": {"screener": 0.0, "ml": 0.204705, "cs": 0.0, "confluence": 0.409413, "technical": 0.255882, "dl": 0.0, "breakout": 0.13, "smart_money": 0.0},
}


def zero_and_redistribute(weights, drop):
    w = dict(weights)
    freed = sum(w[e] for e in drop)
    for e in drop:
        w[e] = 0.0
    pool = sum(w[e] for e in RIVALS)
    for e in RIVALS:
        w[e] += freed * w[e] / pool
    return w


def build_panel(con):
    cols = sorted(set(ENGINE_TO_SCORE_COL.values()) | {"unified_score"})
    ur = pd.read_sql("SELECT symbol, generated_at, classification, regime, est_cost_bps, "
                     + ", ".join(cols) + " FROM unified_recommendations", con)
    ur["d"] = (pd.to_datetime(ur["generated_at"], utc=True)
               + pd.Timedelta(hours=5, minutes=30)).dt.date
    ur = ur.sort_values("generated_at").drop_duplicates(["d", "symbol"], keep="last")
    px = pd.read_sql("SELECT symbol, date, open, close, volume FROM stock_ohlcv "
                     "WHERE date >= %s AND COALESCE(is_suspect,0)=0 AND open > 0 AND close > 0",
                     con, params=(str(min(ur["d"]) - pd.Timedelta(days=45)),))
    px["date"] = pd.to_datetime(px["date"]).dt.date
    px = px.sort_values(["symbol", "date"])
    px["adt_cr"] = ((px["close"] * px["volume"]).groupby(px["symbol"])
                    .transform(lambda s: s.rolling(20, min_periods=10).mean()) / 1e7)
    sessions = sorted(px["date"].unique())
    nxt = {d: [s for s in sessions if s > d][:5] for d in sorted(ur["d"].unique())}
    nxt = {d: v for d, v in nxt.items() if len(v) == 5}
    ur = ur[ur["d"].isin(nxt)].copy()
    idx = px.set_index(["symbol", "date"])
    o_, c_ = idx["open"].to_dict(), idx["close"].to_dict()
    adt = px.dropna(subset=["adt_cr"])
    last_adt = {}
    for d in nxt:  # ADT known at decision time: the last value on or before d
        sub = adt[adt["date"] <= d]
        last_adt[d] = sub.groupby("symbol")["adt_cr"].last().to_dict()
    o2c, o2o, r5, liq = [], [], [], []
    for sym, d in zip(ur["symbol"], ur["d"]):
        s1, s5 = nxt[d][0], nxt[d][4]
        o1, c1, c5 = o_.get((sym, s1)), c_.get((sym, s1)), c_.get((sym, s5))
        o2 = o_.get((sym, nxt[d][1]))
        o2c.append(c1 / o1 - 1 if o1 and c1 else np.nan)
        o2o.append(o2 / o1 - 1 if o1 and o2 else np.nan)
        r5.append(c5 / o1 - 1 if o1 and c5 else np.nan)
        liq.append(last_adt[d].get(sym, np.nan))
    ur["o2c1"], ur["r5"], ur["adt"] = np.clip(o2c, -0.4, 0.4), np.clip(r5, -0.4, 0.4), liq
    # open-to-open, the convention factor_edge.py --entry open uses at h=1 (includes the next night's gap)
    ur["o2o1"] = np.clip(o2o, -0.4, 0.4)
    return ur.dropna(subset=["o2c1"])


def tstat(v):
    v = np.asarray([x for x in v if x == x])
    if len(v) < 3 or v.std(ddof=1) == 0:
        return float("nan")
    return v.mean() / (v.std(ddof=1) / math.sqrt(len(v)))


def component_ic(p):
    print("\n=== Component rank IC (mean over dates; t on independent dates) ===")
    for ret, step in (("o2c1", 1), ("o2o1", 1), ("r5", 5)):
        print(f"-- {ret}")
        for eng, col in ENGINE_TO_SCORE_COL.items():
            per = []
            for d, g in p.groupby("d"):
                x = g[[col, ret]].dropna()
                if len(x) >= 50 and x[col].nunique() > 5:
                    per.append((d, x[col].rank().corr(x[ret].rank())))
            if per:
                v = [s for _, s in sorted(per)]
                print(f"   {eng:12s} IC {np.mean(v):+.4f}  t {tstat(v[::step]):+.2f}  "
                      f"positive {sum(x > 0 for x in v)}/{len(v)}")


def replay(p, arms):
    rows = []
    for d, g in p.groupby("d"):
        norm = {e: _normalize_to_100_series(g[c]) for e, c in ENGINE_TO_SCORE_COL.items()}
        scores = {}
        for name, tbl in arms.items():
            scores[name] = pd.Series(
                [_blend_row({e: norm[e].loc[i] for e in norm},
                            tbl.get(str(r).upper(), tbl["SIDEWAYS"]))
                 for i, r in zip(g.index, g["regime"])], index=g.index)
        fid = pd.concat([scores["BASE"], g["unified_score"]], axis=1).dropna()
        rows.append((d, "_fidelity", "", fid.iloc[:, 0].rank().corr(fid.iloc[:, 1].rank()), np.nan))
        for name, s in scores.items():
            for ret in ("o2c1", "o2o1", "r5"):
                x = pd.DataFrame({"s": s, "r": g[ret], "adt": g["adt"]}).dropna()
                if len(x) < 50:
                    continue
                liq = x[x["adt"] >= 1]
                rows.append((d, name, ret, x["s"].rank().corr(x["r"].rank()),
                             liq["s"].rank().corr(liq["r"].rank()) if len(liq) >= 50 else np.nan))
    return pd.DataFrame(rows, columns=["d", "arm", "ret", "ic", "ic_liq"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--drop", nargs="*", default=[],
                    help="extra experiment: engines to zero in LIVE (weight redistributed over "
                         "ml/confluence/technical); compared against LIVE, not BASE")
    args = ap.parse_args()
    load_dotenv(os.path.join(ROOT, ".env"))
    con = psycopg2.connect(os.environ["POSTGRES_URL"])
    con.set_session(readonly=True)
    con.cursor().execute("SET statement_timeout = '300s'")
    p = build_panel(con)
    dates = sorted(p["d"].unique())
    print(f"panel {len(p):,} rows, {len(dates)} ranker dates {dates[0]}..{dates[-1]}")
    component_ic(p)
    live = {r: dict(w) for r, w in REGIME_WEIGHTS.items()}
    arms = {"BASE": PRE_2026_10_26, "LIVE": live}
    pairs = [("LIVE", "BASE")]
    if args.drop:
        name = "LIVE_DROP_" + "_".join(args.drop).upper()
        arms[name] = {r: zero_and_redistribute(w, args.drop) for r, w in live.items()}
        pairs.append((name, "LIVE"))
    R = replay(p, arms)
    fid = R[R["arm"] == "_fidelity"]["ic"]
    print(f"\nBASE-vs-stored unified_score rank corr: median {fid.median():.3f} "
          "(post-blend vetoes/multipliers are not replayed)")
    half = dates[len(dates) // 2]
    for alt, ref in pairs:
        for ret, step in (("o2c1", 1), ("o2o1", 1), ("r5", 5)):
            a = R[(R["arm"] == alt) & (R["ret"] == ret)].set_index("d")
            b = R[(R["arm"] == ref) & (R["ret"] == ret)].set_index("d")
            for col in ("ic", "ic_liq"):
                dlt = (a[col] - b[col]).dropna().sort_index()
                for lab, sel in (("all", dlt.index >= dates[0]), ("1st", dlt.index < half),
                                 ("2nd", dlt.index >= half)):
                    v = dlt[sel]
                    print(f"{alt} - {ref}  {ret:5s} {col:6s} {lab}: {v.mean():+.4f} "
                          f"t {tstat(v.values[::step]):+.2f}  better on {int((v > 0).sum())}/{len(v)}")


if __name__ == "__main__":
    main()
