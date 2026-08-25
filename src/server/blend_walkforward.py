"""blend_walkforward.py -- permanent ordering-quality harness for unified_ranker (AF-20260823-81).

WHY THIS EXISTS
AF-81 measured the end-user criterion ("do the system's BUY batches overlap the live
market's top gainers?") at 0/30 while pipeline health was clean -- a ranker *ordering*
gap. This harness makes ordering quality continuously measurable instead of ad-hoc:

  1. Rebuilds each historical session's blend EXACTLY as UnifiedRanker.run() does --
     percentile-rank normalize each engine cross-sectionally (_normalize_to_100),
     then a weighted average renormalized over engines present for the symbol (_blend) --
  2. from per-engine scores persisted on unified_recommendations, evaluating BASE vs
     IC-TILTED weights on identical data. TILT estimates are point-in-time expanding-
     window engine ICs with an HORIZON+3-session maturity embargo -- no leakage.
  3. Scores both arms on (a) mean daily 5-day open-entry rank IC (panel-spec honest
     pricing, matching factor_edge --entry open), and (b) AF-81's own criterion:
     top-30 by blended score -> hits in the NEXT session's top-15 gainers + mean edge.
"""
import argparse
import math

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from db_compat import connect
from unified_ranker import (
    ENGINE_TO_SCORE_COL,
    REGIME_WEIGHTS,
    ic_tilted_weights,
    ENGINE_IC_MIN_DATES,
    ENGINE_TILT_CLAMP,
)

HORIZON = 5          # matches ENGINE_EDGE_HORIZON / the ranker's swing focus
TOP_N_BATCH = 30     # AF-81's BUY batch size
TOP_N_GAINERS = 15   # AF-81's gainer cutoff
EMBARGO_SESSIONS = HORIZON + 3   # label maturity gap between estimate window and eval date


def _load_panel(con, since):
    df = pd.DataFrame(con.execute(
        "SELECT symbol, computed_at AS date, regime, unified_score, "
        "screener_stock_score, ml_score, cs_score, confluence_score, "
        "technical_score, dl_score, breakout_score, smart_money_score "
        "FROM unified_recommendations WHERE computed_at >= ?",
        (since,)).fetchall(),
        columns=["symbol", "date", "regime", "unified_score"] + list(ENGINE_TO_SCORE_COL.values()))
    # computed_at carries a time-of-day; collapse to the session date so the
    # dedupe below is per symbol-DAY (latest intraday re-stamp wins) and the
    # join against stock_ohlcv.date (always midnight) keys align.
    df["date"] = pd.to_datetime(df["date"]).dt.normalize()
    for c in list(ENGINE_TO_SCORE_COL.values()) + ["unified_score"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.drop_duplicates(subset=["symbol", "date"], keep="last")
    return df


def _load_prices(con):
    px = pd.DataFrame(con.execute(
        "SELECT symbol, date, open, close FROM stock_ohlcv "
        "WHERE (is_suspect IS NULL OR is_suspect = 0) ORDER BY symbol, date").fetchall(),
        columns=["symbol", "date", "open", "close"])
    px["date"] = pd.to_datetime(px["date"])
    for c in ("open", "close"):
        px[c] = pd.to_numeric(px[c], errors="coerce")
    g = px.groupby("symbol")
    px["fwd"] = g["open"].transform(lambda s: s.shift(-HORIZON - 1) / s.shift(-1) - 1)
    px["next_ret"] = g["close"].transform(lambda s: s.shift(-1) / s - 1)
    return px


def _normalize_to_100_series(s: pd.Series) -> pd.Series:
    """Vectorized mirror of unified_ranker._normalize_to_100 -- EXACT, including ties:
    the ranker computes (less + 0.5*ties)/n, i.e. (pandas average-rank - 0.5)/n."""
    n = int(s.notna().sum())
    if n <= 1:
        return s * np.nan
    return ((s.rank(method="average") - 0.5) / n) * 100.0


def _blend_row(scores: dict, weights: dict) -> float:
    """Mirror of unified_ranker._blend: renormalize weights over engines present."""
    active = {e: w for e, w in weights.items() if scores.get(e) == scores.get(e)
              and scores.get(e) is not None}
    wsum = sum(active.values())
    if wsum <= 0:
        return math.nan
    return sum(active[e] / wsum * scores[e] for e in active)


def daily_engine_ic(day: pd.DataFrame, min_obs: int = 10, min_unique: int = 3) -> dict:
    """Per-session engine IC observations: {engine: 5d open-entry rank IC} for engines
    with enough priced cross-section to be measurable. These accumulate into the
    point-in-time estimates consumed by estimate_ics_asof()."""
    ics = {}
    for eng, col in ENGINE_TO_SCORE_COL.items():
        sub = day[[col, "fwd"]].dropna()
        if len(sub) >= min_obs and sub[col].nunique() > min_unique:
            ic = spearmanr(sub[col], sub["fwd"]).statistic
            if not math.isnan(ic):
                ics[eng] = float(ic)
    return ics


def estimate_ics_asof(daily_ic, pos_of, d, embargo: int = EMBARGO_SESSIONS,
                      min_dates: int = ENGINE_IC_MIN_DATES) -> dict:
    """Point-in-time expanding-window engine IC means as of session date `d`.

    A past session's IC observation is eligible only once its 5d labels have fully
    matured AND `embargo` further trade sessions have passed (label-overlap guard --
    see the module docstring). An engine enters the estimate only with >= min_dates
    distinct eligible dates, mirroring ic_tilted_weights' own evidence gate."""
    p = pos_of.get(pd.Timestamp(d))
    if p is None:
        return {}
    eligible = [ics for dd, ics in daily_ic
                if pos_of.get(dd, -10**9) + embargo < p]
    out = {}
    for eng in ENGINE_TO_SCORE_COL:
        vals = [e[eng] for e in eligible if eng in e]
        if len(vals) >= min_dates:
            out[eng] = {"ic": float(np.mean(vals)), "dates": len(vals)}
    return out


def arm_metrics(m: pd.DataFrame, arm: str) -> dict:
    """Score one arm on one session's panel `m`: rank IC vs the 5d open-entry forward,
    AF-81's criterion (top-TOP_N_BATCH by score hitting the next session's
    top-TOP_N_GAINERS gainers), and the batch's mean next-day edge over the universe
    in percentage points. NaN-blend rows must already be dropped from `m`, or the IC
    silently comes back NaN."""
    ic = (spearmanr(m[arm], m["fwd"]).statistic
          if m[arm].nunique() > 3 else float("nan"))
    top = m.nlargest(TOP_N_BATCH, arm)
    nxt = m["next_ret"].dropna()
    hits = 0
    edge_pp = None
    if len(nxt) >= TOP_N_GAINERS:
        gain_cut = nxt.quantile(1 - TOP_N_GAINERS / len(nxt))
        hits = int((top["next_ret"] >= gain_cut).sum())
        tret = top["next_ret"].dropna()
        if len(tret):
            edge_pp = round(float(tret.mean() - nxt.mean()) * 100, 3)
    return {
        "ic": None if math.isnan(ic) else round(float(ic), 4),
        "hits": hits,
        "edge_pp": edge_pp,
    }


# ── AF-20260823-81 provenance ────────────────────────────────────────────────────
# This harness produced the 2026-08-24 gate verdict: TILT ~= BASE on every criterion
# (mean rank IC 0.0405 -> 0.0401, top-30 gainer hits 6 -> 6, mean next-day edge
# -0.057pp -> -0.068pp over the then-live window), so engine_ic_tilt_enabled stays
# OFF. Re-judge by re-running this once more sessions accumulate behind the earliest
# estimable date (~2026-08-11 given the embargo) -- do NOT re-derive the verdict from
# memory; read the delta line this script prints.


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-06-25")
    args = ap.parse_args()

    con = connect()
    print("[harness] loading recommendation panel ...")
    panel = _load_panel(con, args.since)
    print(f"[harness] {len(panel)} rows, {panel.date.nunique()} sessions, "
          f"{panel.symbol.nunique()} symbols "
          f"({panel.date.min().date()}..{panel.date.max().date()})")
    print("[harness] loading price history ...")
    px = _load_prices(con)
    con.close()
    trade_dates = sorted(px["date"].dropna().unique())
    pos_of = {d: i for i, d in enumerate(trade_dates)}

    merged = panel.merge(px[["symbol", "date", "fwd", "next_ret"]],
                         on=["symbol", "date"], how="left")

    dates = sorted(merged["date"].dropna().unique())

    # â”€â”€ pass 1: per-date engine IC observations (for point-in-time estimates) â”€â”€
    daily_ic = []   # list of (date, {engine: ic})
    for d in dates:
        day = merged[merged["date"] == d]
        daily_ic.append((d, daily_engine_ic(day)))



    # â”€â”€ pass 2: blend under both schemes, score both arms â”€â”€
    rows = []
    for d in dates:
        day = merged[merged["date"] == d].copy()
        if len(day) < 50:
            continue
        regime = day["regime"].dropna().mode()
        base_w = REGIME_WEIGHTS.get(regime.iloc[0] if len(regime) else "BULL",
                                    REGIME_WEIGHTS["BULL"])
        est = estimate_ics_asof(daily_ic, pos_of, d)
        tilt_w, _rep = ic_tilted_weights(dict(base_w), est,
                                         min_dates=ENGINE_IC_MIN_DATES,
                                         clamp=ENGINE_TILT_CLAMP)
        for col in ENGINE_TO_SCORE_COL.values():
            day[col] = _normalize_to_100_series(day[col])
        recs = []
        for r in day.itertuples(index=False):
            scores = {e: getattr(r, c) for e, c in ENGINE_TO_SCORE_COL.items()}
            recs.append((_blend_row(scores, base_w), _blend_row(scores, tilt_w),
                         r.fwd, r.next_ret))
        m = pd.DataFrame(recs, columns=["base", "tilt", "fwd", "next_ret"]).dropna(
            subset=["base", "tilt", "fwd"])   # a NaN blend means no engine data at all
        if len(m) < 50:
            continue
        out = {"date": pd.Timestamp(d).date(), "n": len(m)}
        for arm in ("base", "tilt"):
            met = arm_metrics(m, arm)
            out[f"{arm}_ic"] = met["ic"]
            out[f"{arm}_hits"] = met["hits"]
            out[f"{arm}_edge_pp"] = met["edge_pp"]
        rows.append(out)

    res = pd.DataFrame(rows)
    if res.empty:
        print("\n[harness] no evaluable sessions -- need >=50 priced names per day "
              "with matured 5d labels; try an earlier --since.")
        return
    pd.set_option("display.width", 200)
    print("\n=== per-session [rank IC = 5d open-entry | hits = top-30 in next-session "
          "top-15 gainers | edge_pp = top-30 mean next-day edge vs universe] ===")
    print(res.to_string(index=False))
    summary = {}
    for arm in ("base", "tilt"):
        ics = res[f"{arm}_ic"].dropna()
        edges = res[f"{arm}_edge_pp"].dropna()
        summary[arm] = {
            "mean_rank_ic": round(float(ics.mean()), 4) if len(ics) else None,
            "ic_days_positive": f"{int((ics > 0).sum())}/{len(ics)}" if len(ics) else "-",
            "total_top30_hits": int(res[f"{arm}_hits"].sum()),
            "mean_edge_pp": round(float(edges.mean()), 3) if len(edges) else None,
        }
    print("\n=== SUMMARY (identical data, only weights differ; TILT estimates are "
          "point-in-time, embargoed) ===")
    for arm, s in summary.items():
        print(f"  {arm:5}: {s}")
    b, t = summary["base"], summary["tilt"]
    if t["mean_rank_ic"] is not None and b["mean_rank_ic"] is not None:
        delta = t["mean_rank_ic"] - b["mean_rank_ic"]
        print(f"\n  tilt-vs-base rank-IC delta: {delta:+.4f} | top-30 gainer hits "
              f"{b['total_top30_hits']} -> {t['total_top30_hits']} | "
              f"edge {b['mean_edge_pp']}pp -> {t['mean_edge_pp']}pp")


if __name__ == "__main__":
    main()
