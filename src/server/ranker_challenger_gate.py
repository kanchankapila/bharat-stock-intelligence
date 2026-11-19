"""Champion/challenger gate for the ranker's blend (AF-20261119).

model_promotion.py gates ML models; nothing gated the ranker itself, so every blend change was a hand edit after
an audit. This compares each shadow arm in accuracy_scorecard.py (rebuilt nightly from
unified_recommendations_history) against the PUBLISHED ranking, and says which arm, if any, has earned promotion.

Test (frozen in app_settings 'ranker_challenger_protocol'; changing it is a new version, not an edit):
  * paired by date: per session, arm rank IC minus published rank IC, on the sessions both have (liquid floor
    Rs 1cr, all regimes) -- the same names on the same day, so the market cancels;
  * t on dates / horizon independent windows (overlapping windows are not independent samples);
  * Bonferroni over the challenger arms at the primary horizon: two-sided alpha 0.05 / arms;
  * a CANDIDATE must also not be significantly worse (t <= -2) at any secondary horizon, and its top-decile net
    excess at the primary horizon must be at least the published ranking's;
  * fewer than MIN_DATES_RELIABLE independent windows is LOW-DATA, never a verdict;
  * random_control (published scores shuffled within each session) is the negative control: if IT reads as a
    candidate the test is crediting noise and the gate reports INVALID.

The gate PROPOSES; it never edits REGIME_WEIGHTS. Promoting an arm is an owner decision recorded in
docs/audit-findings.md, and the forward-test-live-decay check watches the result afterwards.

Usage (from src/server):
    python ranker_challenger_gate.py [--json] [--persist]
Reads app_settings 'accuracy_scorecard' (run accuracy_scorecard.py --persist first). --persist writes one
app_settings row, 'ranker_challenger_gate'. Exits 2 on protocol drift.
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import sys
from statistics import NormalDist

import numpy as np

from factor_edge import MIN_DATES_RELIABLE, _effective_dates

KEY = "ranker_challenger_gate"
PROTOCOL_KEY = "ranker_challenger_protocol"
SCORECARD_KEY = "accuracy_scorecard"
PROTOCOL = {
    "version": 1,
    "baseline": "published",
    "negative_control": "random_control",
    "statistic": "per-session rank IC difference (arm - published), paired on common sessions",
    "primary_horizon": 5,
    "secondary_horizons": [10, 21],
    "floor": 1e8,
    "regime": "ALL",
    "alpha_two_sided": 0.05,
    "correction": "Bonferroni over challenger arms",
    "secondary_worse_t": -2.0,
    "excess_tier": 0.1,
    "min_eff_dates": MIN_DATES_RELIABLE,
}


def paired_diff(arm: dict, base: dict, horizon: int) -> dict:
    """arm/base: {'dates': [...], 'ic': [...]} from accuracy_scorecard's ic_series."""
    a = dict(zip(arm.get("dates", []), arm.get("ic", [])))
    b = dict(zip(base.get("dates", []), base.get("ic", [])))
    ok = lambda v: isinstance(v, (int, float)) and math.isfinite(v)    # the snapshot stores NaN as null
    common = sorted(d for d in a if d in b and ok(a[d]) and ok(b[d]))
    x = np.array([a[d] - b[d] for d in common], dtype=float)
    n = len(x)
    eff = _effective_dates(n, horizon)
    sd = float(x.std(ddof=1)) if n > 1 else float("nan")
    t = float(x.mean() / (sd / math.sqrt(max(eff, 1.0)))) if sd == sd and sd > 1e-12 else float("nan")
    return {"dates": n, "eff_dates": float(eff), "mean_ic_diff": float(x.mean()) if n else float("nan"), "t_eff": t}


def _tier_excess(rows: list, arm: str, horizon: int, p: dict) -> float:
    for r in rows:
        if (r.get("arm") == arm and r.get("horizon") == horizon and r.get("regime") == p["regime"]
                and r.get("floor") == p["floor"] and r.get("tier") == p["excess_tier"]):
            v = r.get("excess_050_pct")
            return float(v) if isinstance(v, (int, float)) else float("nan")
    return float("nan")


def evaluate(scorecard: dict, p: dict = PROTOCOL) -> dict:
    ics = scorecard.get("ic_series") or {}
    base = ics.get(p["baseline"], {})
    arms = [a for a in ics if a != p["baseline"]]
    challengers = [a for a in arms if a != p["negative_control"]]
    t_crit = NormalDist().inv_cdf(1 - p["alpha_two_sided"] / (2 * max(len(challengers), 1)))
    h0 = p["primary_horizon"]
    base_excess = _tier_excess(scorecard.get("rows", []), p["baseline"], h0, p)
    out = {}
    for a in arms:
        per_h = {str(h): paired_diff(ics[a].get(str(h), {}), base.get(str(h), {}), h)
                 for h in [h0, *p["secondary_horizons"]]}
        prim = per_h[str(h0)]
        excess = _tier_excess(scorecard.get("rows", []), a, h0, p)
        worse_secondary = [h for h in p["secondary_horizons"]
                           if per_h[str(h)]["t_eff"] == per_h[str(h)]["t_eff"] and per_h[str(h)]["t_eff"] <= p["secondary_worse_t"]]
        excess_ok = excess == excess and base_excess == base_excess and excess >= base_excess
        t = prim["t_eff"]
        if not prim["eff_dates"] >= p["min_eff_dates"]:
            verdict = "LOW-DATA"
        elif t == t and t >= t_crit and not worse_secondary and excess_ok:
            verdict = "CANDIDATE"
        elif t == t and t <= -t_crit:
            verdict = "WORSE"
        else:
            verdict = "NO DIFFERENCE"
        out[a] = {"verdict": verdict, "horizons": per_h, "top_decile_excess_pct": excess,
                  "worse_at_secondary": worse_secondary, "excess_vs_published_ok": bool(excess_ok)}
    control = out.get(p["negative_control"], {}).get("verdict")
    return {"t_crit": t_crit, "baseline_top_decile_excess_pct": base_excess,
            "status": "INVALID" if control == "CANDIDATE" else "OK",
            "arms": out,
            "candidates": [a for a in challengers if out.get(a, {}).get("verdict") == "CANDIDATE"],
            "action": "Owner review: promoting an arm means editing REGIME_WEIGHTS / the arm in unified_ranker.py "
                      "under a docs/audit-findings.md row; this gate never edits them."}


def _protocol(con) -> tuple[str, bool]:
    from forward_test_report import ensure_protocol
    return ensure_protocol(con, PROTOCOL_KEY, PROTOCOL)


def main() -> int:
    from db_compat import connect
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--persist", action="store_true")
    a = ap.parse_args()
    con = connect()
    try:
        h, same = _protocol(con)
        if not same:
            print(f"[challenger_gate] PROTOCOL DRIFT: code hash {h} differs from the frozen protocol; "
                  "start a new version instead of editing it.", file=sys.stderr)
            return 2
        row = con.execute("SELECT value, \"updatedAt\" FROM app_settings WHERE key = ?", (SCORECARD_KEY,)).fetchone()
        if row is None:
            print("[challenger_gate] no accuracy_scorecard snapshot; run accuracy_scorecard.py --persist", file=sys.stderr)
            return 1
        res = {"protocol_hash": h, "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
               "scorecard_as_of": str(row[1]), **evaluate(row[0] if isinstance(row[0], dict) else json.loads(row[0]))}
        if a.persist:
            con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                        'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                        (KEY, json.dumps(res, default=str)))
            con.commit()
    finally:
        con.close()
    if a.json:
        print(json.dumps(res, indent=2, default=str))
    else:
        print(f"[challenger_gate] status {res['status']}, t_crit {res['t_crit']:.2f}, candidates {res['candidates'] or 'none'}")
        for arm, r in res["arms"].items():
            pr = r["horizons"][str(PROTOCOL["primary_horizon"])]
            print(f"  {arm:<24} {r['verdict']:<14} dIC {pr['mean_ic_diff']:+.4f}  t {pr['t_eff']:+.2f}  "
                  f"({pr['eff_dates']:.1f} windows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
