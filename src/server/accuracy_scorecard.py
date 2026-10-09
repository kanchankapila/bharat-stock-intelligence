"""Accuracy scorecard: the published ranking and its shadow arms, graded the forward-test way (spec 2026-10-08, 2.C.2).

A sibling of forward_test_report.py. It imports that module's frozen machinery (publication -> session mapping,
next-session-OPEN entry, per-date winsorisation, the equal-weight benchmark, selective_accuracy, dates/h windows)
and never touches its PROTOCOL; the frozen forward test remains the arbiter. This report adds breadth around it:

  arms      published | reblend | reblend_vol_veto | reblend_no_ml | random_control   (accuracy_shadow_arms.py)
  tiers     top 1/5/10/25/100% of each session's liquid ranked set, plus Buy/Strong Buy as published
  horizons  5, 10, 21 sessions;  liquidity floors Rs 10cr and Rs 50cr trailing-20d ADT
  regimes   ALL; UP/DOWN = NIFTY50 close vs its own 200-session mean; BROAD/NARROW = share of names above their
            50-session mean >= 50%. Objective and point-in-time, deliberately NOT the HMM in market_regimes.
  per row   dates, independent windows, rank IC (+t over windows), hit rate, random-pick hit, lift +-95%,
            net excess at the frozen 0.50% round trip and at 0.30%, payoff ratio, turnover, LOW-DATA flag
  plus      a reliability table and Brier score for technical_signals.calibrated_win_probability against decisive
            signal_outcomes (technical, path_barrier) vs the constant base rate; IC series per arm; top-decile
            distinct-value share of the published score (inputs to accuracy_alerts.py)

Usage (from src/server):
    python accuracy_scorecard.py [--since 2026-08-10] [--json] [--persist]
--persist writes ONE app_settings row, key 'accuracy_scorecard'. Without it the run only SELECTs.
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import sys

import numpy as np
import pandas as pd

import accuracy_shadow_arms as A
import forward_test_report as F
from factor_edge import MIN_DATES_RELIABLE, _effective_dates
from win_definition import classify_outcome

KEY = "accuracy_scorecard"
TIERS = (0.01, 0.05, 0.10, 0.25, 1.00)
HORIZONS = (5, 10, 21)
FLOORS = (1e8, 5e8)
COST_FROZEN = 2 * F.PROTOCOL["cost_per_side"]       # 0.50% round trip
COST_LOW = 0.0030                                    # ROUND_TRIP_COST_PCT
MIN_PER_DATE = 30
INDEX = "NIFTY50"


def _frame(rows, cols):
    return pd.DataFrame(rows) if rows else pd.DataFrame(columns=cols)


# ── pure pieces ───────────────────────────────────────────────────────────────

def objective_regime(index_close: pd.Series, n: int = 200) -> pd.Series:
    mean = index_close.rolling(n, min_periods=n).mean()
    return pd.Series(np.where(mean.isna(), None, np.where(index_close >= mean, "UP", "DOWN")), index=index_close.index)


def calibration_table(p, y, bins: int = 10) -> dict:
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)
    if len(p) == 0:
        return {"n": 0, "brier": None, "brier_base": None, "base_rate": None, "bins": []}
    base = y.mean()
    idx = np.clip((p * bins).astype(int), 0, bins - 1)
    out = [{"lo": i / bins, "hi": (i + 1) / bins, "n": int((idx == i).sum()), "predicted": float(p[idx == i].mean()),
            "realised": float(y[idx == i].mean())} for i in range(bins) if (idx == i).any()]
    return {"n": int(len(p)), "mean_predicted": float(p.mean()), "base_rate": float(base),
            "brier": float(((p - y) ** 2).mean()), "brier_base": float(((base - y) ** 2).mean()), "bins": out}


def turnover(sets) -> float:
    """Mean share of a selection that is new versus the previous session's selection."""
    ch = [1 - len(a & b) / len(b) for a, b in zip(sets, sets[1:]) if b]
    return float(np.mean(ch)) if ch else float("nan")


def payoff_ratio(excess: np.ndarray) -> float:
    w, l = excess[excess > 0], excess[excess < 0]
    return float(w.mean() / -l.mean()) if len(w) and len(l) else float("nan")


def _selections(p: pd.DataFrame, tier, cost: float):
    """Per date (selected symbol set, per-call net excess) using selective_accuracy's own selection rule."""
    sets, ex = [], []
    for _, g in p.dropna(subset=["score", "fwd"]).groupby("date"):
        if len(g) < MIN_PER_DATE:
            continue
        if tier == "published":
            sel = g[g["buy"]]
        else:
            sel = g.sort_values("score", ascending=False, kind="stable").head(max(1, math.ceil(tier * len(g))))
        sets.append(set(sel["symbol"]))
        ex.append((sel["fwd"] - cost - g["fwd"].mean()).to_numpy())
    return sets, (np.concatenate(ex) if ex else np.array([]))


def _ic_stats(ic: pd.Series, horizon: int):
    if len(ic) < 2:
        return float(ic.mean()) if len(ic) else float("nan"), float("nan")
    eff = max(_effective_dates(len(ic), horizon), 1.0)
    sd = ic.std(ddof=1)
    return float(ic.mean()), (float(ic.mean() / (sd / math.sqrt(eff))) if sd > 1e-12 else float("nan"))


def grade_arm(p: pd.DataFrame, arm: str, horizon: int, floor: float, regime: str) -> list[dict]:
    """p: date, symbol, score, fwd, buy for one arm/horizon/floor/regime slice."""
    sa = F.selective_accuracy(p, horizon, TIERS, cost=COST_FROZEN, min_per_date=MIN_PER_DATE)
    if arm == "published":
        sa += F.selective_accuracy(p, horizon, cost=COST_FROZEN, min_per_date=MIN_PER_DATE, flag_col="buy")
    ic = A.session_ic(p, p["score"], p["fwd"], date_col="date", min_n=MIN_PER_DATE)
    ic_mean, ic_t = _ic_stats(ic, horizon)
    rows = []
    for r in sa:
        sets, ex = _selections(p, r["tier"], COST_FROZEN)
        rows.append({"arm": arm, "tier": r["tier"], "horizon": horizon, "floor": floor, "regime": regime,
                     "dates": r["dates"], "eff_dates": r["eff_dates"], "calls_per_date": r["calls_per_date"],
                     "rank_ic": ic_mean, "ic_t_eff": ic_t, "hit_rate": r["hit_rate"], "base_hit": r["base_hit"],
                     "hit_lift": r["hit_lift"], "hit_ci95": r["hit_ci95"],
                     "excess_050_pct": r["mean_excess_pct"], "excess_030_pct": r["mean_excess_pct"] + (COST_FROZEN - COST_LOW) * 100,
                     "t_eff": r["t_eff"], "payoff": payoff_ratio(ex), "turnover": turnover(sets),
                     "verdict": r["verdict"], "low_data": bool(not (r["eff_dates"] >= MIN_DATES_RELIABLE))})
    return rows


# ── database reads (SELECT only) ──────────────────────────────────────────────

HIST_COLS = ["symbol", "generated_at", "regime", "unified_score", "classification",
             "ml_score", "confluence_score", "technical_score", "breakout_score"]


def load_history(con, since: str) -> pd.DataFrame:
    lo = (pd.Timestamp(since) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    df = _frame(con.execute(f"SELECT {', '.join(HIST_COLS)} FROM unified_recommendations_history "
                            "WHERE generated_at >= ? AND unified_score IS NOT NULL", (lo,)).fetchall(), HIST_COLS)
    df["generated_at"] = pd.to_datetime(df["generated_at"], utc=True).dt.tz_convert("Asia/Kolkata")
    for c in HIST_COLS[3:]:
        if c != "classification":
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def load_market_state(con, since: str):
    """(per-symbol 20d realised vol, per-date index regime, per-date breadth), all point-in-time."""
    start = (pd.Timestamp(since) - pd.Timedelta(days=120)).strftime("%Y-%m-%d")
    px = _frame(con.execute("SELECT symbol, date, close FROM stock_ohlcv WHERE date >= ? "
                            "AND (is_suspect IS NULL OR is_suspect = 0)", (start,)).fetchall(), ["symbol", "date", "close"])
    px["date"] = pd.to_datetime(px["date"])
    px["close"] = pd.to_numeric(px["close"], errors="coerce")
    px = px.sort_values(["symbol", "date"])
    g = px.groupby("symbol")["close"]
    px["vol20"] = g.transform(lambda s: np.log(s).diff().rolling(20, min_periods=15).std())
    px["above50"] = px["close"] > g.transform(lambda s: s.rolling(50, min_periods=50).mean())
    has50 = g.transform(lambda s: s.rolling(50, min_periods=50).count()) >= 50
    stocks = px[(px["symbol"] != INDEX) & has50]
    breadth = stocks.groupby("date")["above50"].mean()

    istart = (pd.Timestamp(since) - pd.Timedelta(days=450)).strftime("%Y-%m-%d")
    ix = _frame(con.execute("SELECT date, close FROM stock_ohlcv WHERE symbol = ? AND date >= ? ORDER BY date",
                            (INDEX, istart)).fetchall(), ["date", "close"])
    ix = pd.Series(pd.to_numeric(ix["close"], errors="coerce").to_numpy(), index=pd.to_datetime(ix["date"]))
    return px[["symbol", "date", "vol20"]], objective_regime(ix), breadth


def load_calibration(con, since: str) -> dict:
    rows = con.execute(
        "SELECT t.calibrated_win_probability AS p, o.outcome AS outcome, o.horizon_days AS h "
        "FROM technical_signals t JOIN signal_outcomes o ON o.symbol = t.symbol AND o.signal_date = t.date "
        "WHERE o.signal_source = 'technical' AND o.label_definition = 'path_barrier' AND o.horizon_days IN (5, 15) "
        "AND o.outcome IN ('WIN','LOSS','STOP_LOSS') AND t.date >= ? AND t.calibrated_win_probability IS NOT NULL",
        (since,)).fetchall()
    df = _frame(rows, ["p", "outcome", "h"])
    df["p"] = pd.to_numeric(df["p"], errors="coerce")
    df["y"] = [1 if classify_outcome(o) == "WIN" else 0 for o in df["outcome"]]
    return {str(h): calibration_table(df.loc[df["h"] == h, "p"], df.loc[df["h"] == h, "y"]) for h in (5, 15)}


# ── assembly ──────────────────────────────────────────────────────────────────

def build_scorecard(con, since: str) -> dict:
    sessions = F.load_sessions(con)
    calls = F.apply_protocol_start(F.latest_call_per_session(load_history(con, since), sessions), since)
    out = {"since": since, "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
           "forward_test_protocol_hash": F.protocol_hash(F.PROTOCOL), "cost_round_trip": [COST_FROZEN, COST_LOW],
           "calls": int(len(calls)), "sessions": int(calls["session"].nunique()) if len(calls) else 0,
           "rows": [], "ic_series": {}, "dispersion": {}, "calibration": load_calibration(con, since)}
    if calls.empty:
        return out
    vol, idx_regime, breadth = load_market_state(con, since)
    calls = calls.merge(vol.rename(columns={"date": "session"}), on=["symbol", "session"], how="left")
    arms = A.arm_scores(calls, calls["vol20"])
    for a in A.ARMS:
        calls[f"arm_{a}"] = arms[a]
    calls["buy"] = calls["classification"].isin(["Buy", "Strong Buy"])

    disp = []
    for d, g in calls.groupby("session"):
        top = g.nlargest(max(1, math.ceil(0.10 * len(g))), "unified_score")["unified_score"]
        disp.append((str(d.date()), float(top.nunique() / len(top))))
    out["dispersion"] = {"dates": [d for d, _ in disp], "top_decile_distinct_share": [s for _, s in disp]}

    for floor in FLOORS:
        panel = F.build_panel(con, calls, sessions, list(HORIZONS), floor)
        reg = panel["date"].map(idx_regime)
        brd = panel["date"].map(breadth)
        slices = {"ALL": panel.index == panel.index, "UP": reg == "UP", "DOWN": reg == "DOWN",
                  "BROAD": brd >= 0.5, "NARROW": brd < 0.5}
        for regime, mask in slices.items():
            sub = panel[np.asarray(mask, dtype=bool)]
            if sub.empty:
                continue
            for h in HORIZONS:
                for a in A.ARMS:
                    p = sub[["date", "symbol", "buy", f"arm_{a}", f"fwd_{h}"]].rename(columns={f"arm_{a}": "score", f"fwd_{h}": "fwd"})
                    out["rows"] += grade_arm(p, a, h, floor, regime)
                    if floor == FLOORS[0] and regime == "ALL":
                        ic = A.session_ic(p, p["score"], p["fwd"], date_col="date", min_n=MIN_PER_DATE)
                        out["ic_series"].setdefault(a, {})[str(h)] = {"dates": [str(d.date()) for d in ic.index],
                                                                       "ic": [float(x) for x in ic]}
    return out


def _clean(o):
    if isinstance(o, float):
        return None if not math.isfinite(o) else o
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, np.integer, np.bool_)):
        return _clean(o.item())
    return o


def attach_alerts(out: dict) -> dict:
    from accuracy_alerts import evaluate
    out["alerts"] = evaluate(out)
    return out


def persist_snapshot(con, out: dict) -> None:
    con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                (KEY, json.dumps(_clean(out), default=str)))
    con.commit()


def print_report(out: dict, floor: float = FLOORS[0], tiers=("published", 0.10)) -> None:
    f = lambda x, fmt: "n/a" if x is None or x != x else format(x, fmt)
    print(f"accuracy scorecard since {out['since']}  calls={out['calls']}  sessions={out['sessions']}  "
          f"(retrospective; the frozen forward test {out['forward_test_protocol_hash']} is the arbiter)")
    print(f"floor Rs {floor / 1e7:.0f}cr ADT | hit = beat the equal-weight universe mean after 0.50% | lift = hit - random pick")
    print(f"{'arm':>17} {'tier':>9} {'h':>3} {'regime':>6} {'dates':>5} {'eff':>5} {'IC':>7} {'IC_t':>6} {'hit':>6} "
          f"{'base':>6} {'lift':>7} {'+-95':>6} {'ex@.30':>7} {'ex@.50':>7} {'t_eff':>6} {'payoff':>6} {'turn':>5}  flag")
    for r in out["rows"]:
        if r["floor"] != floor or r["tier"] not in tiers:
            continue
        print(f"{r['arm']:>17} {str(r['tier']):>9} {r['horizon']:>3} {r['regime']:>6} {r['dates']:>5} {r['eff_dates']:5.1f} "
              f"{f(r['rank_ic'], '+7.3f'):>7} {f(r['ic_t_eff'], '6.2f'):>6} {f(r['hit_rate'], '6.3f'):>6} "
              f"{f(r['base_hit'], '6.3f'):>6} {f(r['hit_lift'], '+7.3f'):>7} {f(r['hit_ci95'], '6.3f'):>6} "
              f"{f(r['excess_030_pct'], '+7.3f'):>7} {f(r['excess_050_pct'], '+7.3f'):>7} {f(r['t_eff'], '6.2f'):>6} "
              f"{f(r['payoff'], '6.2f'):>6} {f(r['turnover'], '5.2f'):>5}  {'LOW-DATA' if r['low_data'] else r['verdict']}")
    for h, c in out["calibration"].items():
        if c["n"]:
            print(f"calibration {h}d: n={c['n']} mean predicted {c['mean_predicted']:.3f} vs decisive-WIN base {c['base_rate']:.3f}; "
                  f"Brier {c['brier']:.4f} vs base-rate {c['brier_base']:.4f}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default="2026-08-10")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--persist", action="store_true", help="write app_settings['accuracy_scorecard'] (one row)")
    a = ap.parse_args()
    from db_compat import connect
    con = connect()
    try:
        out = attach_alerts(build_scorecard(con, a.since))
        if a.json:
            print(json.dumps(_clean(out), indent=2, default=str))
        else:
            print_report(out)
        if a.persist:
            persist_snapshot(con, out)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
