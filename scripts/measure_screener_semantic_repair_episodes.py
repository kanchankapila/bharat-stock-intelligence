"""The 2026-11-06 semantic-repair replay on valid, episode-built membership (AF-20261106-01, AF-20261106-04).

Pre-registered in docs/audits/2026-11-21-screener-semantic-replay-rerun-preregistration.md. Same manifest, policy,
scoring, universe and metrics as `measure_screener_semantic_repair.py`, which is not modified; only the membership
source differs (episodes, not the truncated capture). Read-only. Refuses to overwrite its report.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/server"))
import screener_membership_replay as R  # noqa: E402
from db_compat import connect  # noqa: E402
from screener_semantics import analyze_screener, deduplicate_membership  # noqa: E402
import unified_ranker as ranker  # noqa: E402

POLICY_PATH = Path(__file__).resolve().parents[1] / "src/server/config/screenerSemantics.json"
COST_PCT = 0.32


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--report", required=True, type=Path)
    ap.add_argument("--since", default="2026-09-01")
    ap.add_argument("--until", default="2026-11-19")
    args = ap.parse_args()
    if args.report.exists():
        raise RuntimeError("Replay artifacts are immutable; choose a new output path.")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if manifest.get("policy_sha256") != hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest():
        raise RuntimeError("Policy differs from the frozen manifest; refusing to grade it.")
    since, until = dt.date.fromisoformat(args.since), dt.date.fromisoformat(args.until)
    template = {(r["source"].lower(), r["id"]): r for r in manifest["decisions"] if r["table"] == "screener_catalog"}
    con = connect()
    con.execute("SET TRANSACTION READ ONLY")
    con.execute("SET LOCAL statement_timeout = '600s'")
    try:
        catalog = {(r["source"].lower(), r["screener_id"]): dict(r) for r in con.execute(
            "SELECT screener_id, source, category, subcategory, investment_horizon, confidence FROM screener_catalog").fetchall()}
        ep = R.drop_shared(R.load_episodes(con, since), R.shared_screener_ids(con))
        ep = R.attach_last_seen(ep, R.load_last_seen(con))
        rows = con.execute("SELECT symbol, date::date AS date, open, close, volume FROM stock_ohlcv "
                           "WHERE date >= ? AND COALESCE(is_suspect, 0) = 0 AND open > 0 AND close > 0",
                           ((since - dt.timedelta(days=60)).isoformat(),)).fetchall()
        px = pd.DataFrame([tuple(r) for r in rows], columns=["symbol", "date", "open", "close", "volume"])
        px["date"] = pd.to_datetime(px["date"]).dt.date
        px = px.sort_values(["symbol", "date"])
        px["adt"] = (px["close"] * px["volume"]).groupby(px["symbol"]).transform(
            lambda x: x.rolling(20, min_periods=20).mean()) / 1e7
        sessions = sorted(px["date"].unique())
        indexed = px.set_index(["symbol", "date"])
        daily = []
        for i, day in enumerate(sessions[:-1]):
            if not (since <= day <= until):
                continue
            entry = sessions[i + 1]
            members = R.new_arm(ep, day)
            old, new = defaultdict(list), defaultdict(list)
            for symbol, source, sid in zip(members["symbol"], members["source"], members["screener_id"]):
                key = (source.lower(), str(sid))
                if key not in template or key not in catalog:
                    continue
                t = template[key]
                record = {**catalog[key], "source": source, "screener_id": str(sid), "screener_name": t["name"]}
                old[symbol].append({**record, "signal_bias": t["bias"]})
                new[symbol].append({**record, "signal_bias": analyze_screener(t["name"], source, str(sid))["semantic_bias"]})
            baseline, _, _ = ranker.compute_screener_stock_scores(
                old, {}, bias_sign={"bullish": 1.0, "bearish": -1.0, "neutral": 0.3})
            candidate, _, _ = ranker.compute_screener_stock_scores(
                deduplicate_membership(new), {}, bias_sign={"bullish": 1.0, "bearish": -1.0, "neutral": 0.0})
            adt = px[px["date"] <= day].groupby("symbol").last()["adt"].to_dict()
            outcomes = {}
            for symbol in baseline.keys() & candidate.keys():
                if adt.get(symbol, 0) < 1 or (symbol, entry) not in indexed.index:
                    continue
                bar = indexed.loc[(symbol, entry)]
                ret = (bar["close"] / bar["open"] - 1) * 100
                if np.isfinite(ret) and abs(ret) <= 40:
                    outcomes[symbol] = ret
            if len(outcomes) < 50:
                continue
            panel = pd.DataFrame({"return": outcomes, "before": baseline, "after": candidate}).dropna()
            benchmark = panel["return"].mean()
            rec = {"decision_date": str(day), "entry_date": str(entry), "symbols": int(len(panel)),
                   "before_distinct": int(panel["before"].nunique()), "after_distinct": int(panel["after"].nunique()),
                   "memberships": int(len(members))}
            for label in ("before", "after"):
                rec[label + "_ic"] = float(panel[label].corr(panel["return"], method="spearman"))
                rec[label + "_top50_net_excess_pct"] = float(
                    panel.nlargest(50, label)["return"].mean() - benchmark - COST_PCT)
            daily.append(rec)
            print(f"{day} symbols={rec['symbols']} before_ic={rec['before_ic']:.4f} after_ic={rec['after_ic']:.4f}", flush=True)

        ic_delta = [r["after_ic"] - r["before_ic"] for r in daily]
        net_delta = [r["after_top50_net_excess_pct"] - r["before_top50_net_excess_pct"] for r in daily]
        half = len(daily) // 2
        halves = {"first_half": R.paired_stats(ic_delta[:half]), "second_half": R.paired_stats(ic_delta[half:])}
        harmful = any(h["t"] is not None and h["t"] <= -2 for h in halves.values())
        report = {
            "preregistration": "docs/audits/2026-11-21-screener-semantic-replay-rerun-preregistration.md",
            "verdict": ("LOW-DATA (< 20 graded dates)" if len(daily) < 20 else
                        ("HARMFUL under the AF-20261026-71 ship rule (t <= -2 in a half)" if harmful
                         else "NOT HARMFUL under the AF-20261026-71 ship rule; authorises no relabeling")),
            "capture_completeness": "episodes rebuilt per date, gated by provider last_seen, shared ids dropped",
            "manifest_sha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
            "graded_dates": len(daily),
            "paired_ic_delta": R.paired_stats(ic_delta), "paired_ic_delta_halves": halves,
            "paired_net_delta_pct": R.paired_stats(net_delta),
            "own_ic_before": R.paired_stats([r["before_ic"] for r in daily]),
            "own_ic_after": R.paired_stats([r["after_ic"] for r in daily]),
            "caveat": "Template names/categories are the current ones (hindsight); one falling tape; a check of the policy, not evidence of an edge.",
            "daily": daily,
        }
        args.report.write_text(json.dumps(report, indent=2, allow_nan=False, default=str) + "\n", encoding="utf-8")
        print(json.dumps({k: report[k] for k in ("verdict", "graded_dates", "paired_ic_delta", "paired_ic_delta_halves")}, indent=2))
    finally:
        con.rollback()
        con.close()


if __name__ == "__main__":
    main()
