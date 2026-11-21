"""Paired replay of the screener membership definitions, as pre-registered in
docs/audits/2026-11-21-screener-membership-preregistration.md (AF-20261106-04). Read-only.

Writes `<out-dir>/per_date.csv` and `<out-dir>/report.json`; refuses to overwrite either.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import io
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/server"))
import screener_membership_replay as R  # noqa: E402
import screener_features_fetcher as F  # noqa: E402
from db_compat import connect  # noqa: E402

FEATURES = ["screener_momentum_score", "screener_bull_count", "screener_bear_count",
            "screener_tier1_count", "screener_cat_breadth", "screener_alpha_score"]
PRIMARY = "screener_momentum_score"
COST_PCT = 0.32
MIN_NAMES = 50
MIN_ADT_CR = 1.0
MAX_ABS_RET = 40.0
ARMS = ["old", "new", "new_g1", "new_g7", "new_nogate"]


def arm_members(ep: pd.DataFrame, arm: str, day: dt.date) -> pd.DataFrame:
    if arm == "old":
        return R.old_arm(ep, day)
    if arm == "new":
        return R.new_arm(ep, day)
    if arm == "new_g1":
        return R.new_arm(ep, day, grace_days=1)
    if arm == "new_g7":
        return R.new_arm(ep, day, grace_days=7)
    d = pd.Timestamp(day)  # new_nogate: every open episode, liveness ignored
    return ep[(ep["a"] <= d) & (ep["x"].isna() | (ep["x"] >= d))]


def top50_net(score: pd.Series, ret: pd.Series) -> float:
    order = pd.DataFrame({"s": score, "r": ret}).rename_axis("sym").reset_index().sort_values(
        ["s", "sym"], ascending=[False, True])
    return float(order.head(50)["r"].mean() - ret.mean() - COST_PCT)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since", default="2026-09-01")
    ap.add_argument("--until", default="2026-11-19")
    ap.add_argument("--out-dir", required=True, type=Path)
    args = ap.parse_args()
    since, until = dt.date.fromisoformat(args.since), dt.date.fromisoformat(args.until)
    per_date = args.out_dir / "per_date.csv"
    report_path = args.out_dir / "report.json"
    if per_date.exists() or report_path.exists():
        raise RuntimeError("Replay artifacts are immutable; choose a new output directory.")
    args.out_dir.mkdir(parents=True, exist_ok=True)

    con = connect()
    con.execute("SET TRANSACTION READ ONLY")
    con.execute("SET LOCAL statement_timeout = '600s'")
    try:
        ep = R.load_episodes(con, since)
        shared = R.shared_screener_ids(con)
        ep = R.drop_shared(ep, shared)
        ep = R.attach_last_seen(ep, R.load_last_seen(con))
        rows = con.execute(
            "SELECT symbol, date::date AS date, open, close, volume FROM stock_ohlcv "
            "WHERE date >= ? AND COALESCE(is_suspect, 0) = 0 AND open > 0 AND close > 0",
            ((since - dt.timedelta(days=60)).isoformat(),)).fetchall()
        px = pd.DataFrame([tuple(r) for r in rows], columns=["symbol", "date", "open", "close", "volume"])
        px["date"] = pd.to_datetime(px["date"]).dt.date
        px = px.sort_values(["symbol", "date"])
        px["adt"] = (px["close"] * px["volume"]).groupby(px["symbol"]).transform(
            lambda x: x.rolling(20, min_periods=20).mean()) / 1e7
        sessions = sorted(px["date"].unique())
        indexed = px.set_index(["symbol", "date"])
        graded = []
        for i, day in enumerate(sessions[:-1]):
            if not (since <= day <= until):
                continue
            entry = sessions[i + 1]
            adt = px[px["date"] <= day].groupby("symbol").last()["adt"]
            entry_bars = px[px["date"] == entry].set_index("symbol")
            ret = ((entry_bars["close"] / entry_bars["open"] - 1) * 100)
            universe = ret.index[(adt.reindex(ret.index) >= MIN_ADT_CR) & (ret.abs() <= MAX_ABS_RET)]
            if len(universe) < MIN_NAMES:
                continue
            r = ret.loc[universe]
            with contextlib.redirect_stdout(io.StringIO()):
                meta = F.load_screener_meta(con, as_of=day.isoformat())
            rec = {"decision_date": str(day), "entry_date": str(entry), "names": int(len(universe))}
            for arm in ARMS:
                members = arm_members(ep, arm, day)
                feats = R.features(members, meta, F.compute_features).reindex(universe).fillna(0.0)
                rec[f"{arm}_members"] = int(len(members))
                rec[f"{arm}_covered"] = float((feats["screener_bull_count"] + feats["screener_bear_count"] > 0).mean())
                for f in FEATURES:
                    s = feats[f]
                    rec[f"{arm}_{f}_ic"] = float(s.corr(r, method="spearman")) if s.nunique() > 1 else float("nan")
                rec[f"{arm}_top50_net"] = top50_net(feats[PRIMARY], r)
            graded.append(rec)
            print(f"{day} names={len(universe)} old_ic={rec['old_screener_momentum_score_ic']:.4f} "
                  f"new_ic={rec['new_screener_momentum_score_ic']:.4f}", flush=True)
        df = pd.DataFrame(graded)
        df.to_csv(per_date, index=False)

        half = len(df) // 2

        def delta(arm: str, feature: str, rows_=None) -> dict:
            d = (df[f"{arm}_{feature}_ic"] - df[f"old_{feature}_ic"]) if rows_ is None else \
                (df[f"{arm}_{feature}_ic"] - df[f"old_{feature}_ic"]).iloc[rows_]
            out = R.paired_stats(d)
            out["better"] = int((d > 0).sum())
            return out

        def block(arm: str) -> dict:
            return {f: {"all": delta(arm, f), "first_half": delta(arm, f, slice(0, half)),
                        "second_half": delta(arm, f, slice(half, None))} for f in FEATURES}

        primary = block("new")[PRIMARY]
        harmful = any((primary[k]["t"] is not None and primary[k]["t"] <= -2) for k in ("first_half", "second_half"))
        report = {
            "preregistration": "docs/audits/2026-11-21-screener-membership-preregistration.md",
            "dates": len(df), "first": df["decision_date"].iloc[0], "last": df["decision_date"].iloc[-1],
            "shared_pairs_dropped": len(shared),
            "verdict": ("LOW-DATA (< 20 graded dates)" if len(df) < 20 else
                        ("HARMFUL under the AF-20261026-71 ship rule (t <= -2 in a half)" if harmful
                         else "NOT HARMFUL under the AF-20261026-71 ship rule (no half has t <= -2); adds no edge claim")),
            "primary_paired_ic_delta_new_minus_old": primary,
            "paired_ic_delta_by_feature": block("new"),
            "own_ic_vs_zero": {arm: {f: R.paired_stats(df[f"{arm}_{f}_ic"]) for f in FEATURES} for arm in ("old", "new")},
            "top50_net_excess_pct": {arm: R.paired_stats(df[f"{arm}_top50_net"]) for arm in ARMS},
            "top50_net_paired_delta_new_minus_old": R.paired_stats(df["new_top50_net"] - df["old_top50_net"]),
            "coverage_mean": {arm: float(df[f"{arm}_covered"].mean()) for arm in ARMS},
            "members_mean": {arm: float(df[f"{arm}_members"].mean()) for arm in ARMS},
            "sensitivity_primary": {arm: block(arm)[PRIMARY]["all"] for arm in ("new_g1", "new_g7", "new_nogate")},
        }
        report_path.write_text(json.dumps(report, indent=2, allow_nan=False, default=str) + "\n", encoding="utf-8")
        print(json.dumps({k: report[k] for k in ("dates", "verdict", "primary_paired_ic_delta_new_minus_old")}, indent=2))
    finally:
        con.rollback()
        con.close()


if __name__ == "__main__":
    main()
