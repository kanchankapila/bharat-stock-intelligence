"""Accuracy scorecard: the published ranking and its shadow arms, graded the forward-test way (spec 2026-10-08, 2.C.2).

A sibling of forward_test_report.py. It imports that module's frozen machinery (publication -> session mapping,
next-session-OPEN entry, per-date winsorisation, the equal-weight benchmark, selective_accuracy, dates/h windows)
and never touches its PROTOCOL; the frozen forward test remains the arbiter. This report adds breadth around it:

  arms      published | reblend | reblend_vol_veto | reblend_no_ml | random_control | reblend_no_sector_slot   (accuracy_shadow_arms.py)
  tiers     top 1/5/10/25/100% of each session's liquid ranked set, plus Buy/Strong Buy as published
  horizons  5, 10, 21 sessions;  liquidity floors Rs 10cr and Rs 50cr trailing-20d ADT
  regimes   ALL; UP/DOWN = NIFTY50 close vs its own 200-session mean; BROAD/NARROW = share of names above their
            50-session mean >= 50%. Objective and point-in-time, deliberately NOT the HMM in market_regimes.
  per row   dates, independent windows, rank IC (+t over windows), hit rate, random-pick hit, lift +-95%,
            net excess at the frozen 0.50% round trip and at 0.30%, payoff ratio, turnover, LOW-DATA flag;
            beside those, net excess at each call's own est_cost_bps with its coverage, and 0.30% on those same rows
  plus      a reliability table and Brier score for technical_signals.calibrated_win_probability against decisive
            signal_outcomes (technical, path_barrier) vs a TRAILING purged base rate (the alert's benchmark) and,
            descriptively, the same rows' hindsight base rate; IC series per arm; top-decile
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


HINDSIGHT_LABEL = "hindsight base rate (realised rate of these same rows; unknowable when the forecast was made)"
TRAILING_WINDOW = 20      # signal dates
TRAILING_MIN_DATES = 10


def trailing_bases(dates, y, horizon: int, window: int = TRAILING_WINDOW, min_dates: int = TRAILING_MIN_DATES):
    """Per row, the decisive-WIN rate of the `window` most recent signal dates whose outcome had closed: index
    <= t - horizon on the calendar of signal dates (purged by the horizon). NaN while fewer than `min_dates` qualify.
    The constant a forecaster could actually have known at t (AF-20261008-45)."""
    d = pd.to_datetime(np.asarray(dates))
    g = pd.Series(np.asarray(y, dtype=float), index=d).groupby(level=0)
    s, n = g.sum(), g.size()
    cs, cn = np.concatenate([[0], np.cumsum(s.to_numpy())]), np.concatenate([[0], np.cumsum(n.to_numpy())])
    base = np.full(len(s), np.nan)
    for t in range(len(s)):
        hi = t - horizon + 1                       # dates [lo, hi) have closed
        lo = max(0, hi - window)
        if hi - lo >= min_dates:
            base[t] = (cs[hi] - cs[lo]) / (cn[hi] - cn[lo])
    return pd.Series(base, index=s.index).reindex(d).to_numpy()


def trailing_base_benchmark(dates, p, y, horizon: int, reps: int = 2000, seed: int = 0) -> dict:
    """Brier of p minus Brier of the trailing purged base rate, paired on the same rows, with a moving-block
    bootstrap CI over signal dates (block = horizon dates, since overlapping windows are not independent)."""
    df = pd.DataFrame({"d": pd.to_datetime(np.asarray(dates)), "p": np.asarray(p, dtype=float),
                       "y": np.asarray(y, dtype=float)})
    df["b"] = trailing_bases(df["d"], df["y"], horizon)
    df = df.dropna()
    if df.empty:
        return {"n": 0, "dates": 0, "brier": None, "brier_trailing_base": None, "diff": None, "ci95": None,
                "low_data": True, "window": TRAILING_WINDOW, "purge_dates": int(horizon)}
    g = df.assign(a=(df.p - df.y) ** 2, c=(df.b - df.y) ** 2).groupby("d").agg(a=("a", "sum"), c=("c", "sum"), n=("y", "size"))
    a, c, n = g.a.to_numpy(), g.c.to_numpy(), g.n.to_numpy()
    T, L = len(n), max(1, int(horizon))
    out = {"n": int(n.sum()), "dates": int(T), "brier": float(a.sum() / n.sum()),
           "brier_trailing_base": float(c.sum() / n.sum()), "diff": float((a.sum() - c.sum()) / n.sum()),
           "ci95": None, "low_data": T < 2 * L, "window": TRAILING_WINDOW, "purge_dates": int(horizon)}
    if out["low_data"]:                            # under two independent blocks a resample is the series itself
        return out
    rng = np.random.default_rng(seed)
    st = rng.integers(0, T - L + 1, (reps, int(np.ceil(T / L))))
    idx = (st[:, :, None] + np.arange(L)).reshape(reps, -1)[:, :T]
    boot = (a[idx].sum(1) - c[idx].sum(1)) / n[idx].sum(1)
    out["ci95"] = [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))]
    return out


def turnover(sets) -> float:
    """Mean share of a selection that is new versus the previous session's selection."""
    ch = [1 - len(a & b) / len(b) for a, b in zip(sets, sets[1:]) if b]
    return float(np.mean(ch)) if ch else float("nan")


def payoff_ratio(excess: np.ndarray) -> float:
    w, l = excess[excess > 0], excess[excess < 0]
    return float(w.mean() / -l.mean()) if len(w) and len(l) else float("nan")


def _select(g: pd.DataFrame, tier) -> pd.DataFrame:
    if tier == "published":
        return g[g["buy"]]
    return g.sort_values("score", ascending=False, kind="stable").head(max(1, math.ceil(tier * len(g))))


def _selections(p: pd.DataFrame, tier, cost: float):
    """Per date (selected symbol set, per-call net excess) using selective_accuracy's own selection rule."""
    sets, ex = [], []
    for _, g in p.dropna(subset=["score", "fwd"]).groupby("date"):
        if len(g) < MIN_PER_DATE:
            continue
        sel = _select(g, tier)
        sets.append(set(sel["symbol"]))
        ex.append((sel["fwd"] - cost - g["fwd"].mean()).to_numpy())
    return sets, (np.concatenate(ex) if ex else np.array([]))


def net_at_own_cost(fwd: pd.Series, est_cost_bps: pd.Series) -> pd.Series:
    """Forward return (fraction) net of the call's own round trip. A missing cost stays missing, never zero cost."""
    return fwd - pd.to_numeric(est_cost_bps, errors="coerce") / 10_000


def own_cost_figures(p: pd.DataFrame, tier, horizon: int) -> dict:
    """Net excess at each call's own est_cost_bps, only on calls that have one, plus 0.30% on those SAME calls: the
    covered dates are a subset of the panel, so excess_030_pct is not comparable. Reporting only (AF-20261103-08)."""
    calls = missing = 0
    per_date = []
    for _, g in p.dropna(subset=["score", "fwd"]).groupby("date"):
        if len(g) < MIN_PER_DATE:
            continue
        sel = _select(g, tier)
        net = net_at_own_cost(sel["fwd"], sel["est_cost_bps"]).dropna()
        calls += len(net)
        missing += len(sel) - len(net)
        if len(net):
            u = g["fwd"].mean()
            per_date.append(((net - u).mean(), (sel.loc[net.index, "fwd"] - COST_LOW - u).mean()))
    own, flat = np.array(per_date).T if per_date else (np.array([np.nan]), np.array([np.nan]))
    eff = _effective_dates(len(per_date), horizon)
    return {"excess_own_pct": float(own.mean() * 100), "excess_030_same_rows_pct": float(flat.mean() * 100),
            "own_cost_calls": calls, "own_cost_missing": missing,
            "own_cost_coverage": calls / (calls + missing) if calls + missing else float("nan"),
            "own_cost_dates": len(per_date), "own_cost_eff_dates": float(eff),
            "own_cost_low_data": bool(not (eff >= MIN_DATES_RELIABLE))}


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
                     "verdict": r["verdict"], "low_data": bool(not (r["eff_dates"] >= MIN_DATES_RELIABLE)),
                     **own_cost_figures(p, r["tier"], horizon)})
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
    # est_cost_bps is only on unified_recommendations. Matching the exact run keeps it point-in-time: a later run's cost
    # never reaches an earlier call, and a call whose row was overwritten stays NULL. A second query and a left merge
    # leave the history row order alone, because score ties break on row order and existing figures must not move.
    costs = _frame(con.execute("SELECT symbol, generated_at, est_cost_bps FROM unified_recommendations "
                               "WHERE generated_at >= ? AND est_cost_bps IS NOT NULL", (lo,)).fetchall(),
                   ["symbol", "generated_at", "est_cost_bps"])
    costs["generated_at"] = pd.to_datetime(costs["generated_at"], utc=True).dt.tz_convert("Asia/Kolkata")
    costs["est_cost_bps"] = pd.to_numeric(costs["est_cost_bps"], errors="coerce")
    return df.merge(costs, on=["symbol", "generated_at"], how="left")


def attach_confluence_parts(con, calls: pd.DataFrame, sessions: pd.DatetimeIndex) -> pd.DataFrame:
    """Add A.SLOT_COLS to each call: the four confluence sub-scores the ranker read for that run, i.e. per symbol the latest
    confluence_signals row computed AT OR BEFORE the call (never after) and no earlier than the previous session's midnight
    IST (unified_ranker._get_confluence_scores' window). One bounded read per distinct call time, four columns only: the
    table is a ~6GB hypertable and an unbounded read decompressed it whole (memory_contention_root_causes_2026_09_30)."""
    cols = ["trend_alignment_score", "volume_score", "sector_strength_score", "fundamental_score"]
    sql = (f"SELECT DISTINCT ON (symbol) symbol, {', '.join(cols)} FROM confluence_signals "
           "WHERE computed_at >= ? AND computed_at <= ? AND symbol NOT LIKE '%://%' AND LENGTH(symbol) <= 20 "
           "ORDER BY symbol, computed_at DESC")
    parts = []
    for t in calls["generated_at"].drop_duplicates():
        day = pd.Timestamp(t.tz_convert("Asia/Kolkata").date())
        i = sessions.searchsorted(day, side="left") - 1
        lo = pd.Timestamp(sessions[i] if i >= 0 else day - pd.Timedelta(days=5)).tz_localize("Asia/Kolkata")
        rows = con.execute(sql, (lo.to_pydatetime(), t.to_pydatetime())).fetchall()
        parts.append(_frame(rows, ["symbol", *cols]).assign(generated_at=t))
    got = pd.concat(parts, ignore_index=True) if parts else _frame([], ["symbol", *cols, "generated_at"])
    got = got.rename(columns=dict(zip(cols, A.SLOT_COLS)))
    return calls.merge(got, on=["symbol", "generated_at"], how="left")     # left merge keeps the call order score ties break on


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
        "SELECT t.calibrated_win_probability AS p, o.outcome AS outcome, o.horizon_days AS h, t.date AS d "
        "FROM technical_signals t JOIN signal_outcomes o ON o.symbol = t.symbol AND o.signal_date = t.date "
        "WHERE o.signal_source = 'technical' AND o.label_definition = 'path_barrier' AND o.horizon_days IN (5, 15) "
        "AND o.outcome IN ('WIN','LOSS','STOP_LOSS') AND t.date >= ? AND t.calibrated_win_probability IS NOT NULL",
        (since,)).fetchall()
    df = _frame(rows, ["p", "outcome", "h", "d"])
    df["p"] = pd.to_numeric(df["p"], errors="coerce")
    df["y"] = [1 if classify_outcome(o) == "WIN" else 0 for o in df["outcome"]]
    out = {}
    for h in (5, 15):
        s = df[df["h"] == h]
        out[str(h)] = {**calibration_table(s["p"], s["y"]), "brier_base_label": HINDSIGHT_LABEL,
                       "trailing": trailing_base_benchmark(s["d"], s["p"], s["y"], h)}
    return out


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
    try:
        calls = attach_confluence_parts(con, calls, sessions)
    except Exception as e:                                  # a shadow arm must not take the scorecard (and its alerts) down; db_compat rolls the aborted transaction back
        out["no_sector_slot_error"] = f"{type(e).__name__}: {e}"[:300]
    arms = A.arm_scores(calls, calls["vol20"])
    for a in A.ARMS:
        calls[f"arm_{a}"] = arms[a]
    covered = calls["arm_reblend_no_sector_slot"].notna().groupby(calls["session"]).any()
    out["no_sector_slot"] = {"sessions_covered": int(covered.sum()), "sessions_excluded": int((~covered).sum()),
                             "excluded": [str(d.date()) for d in covered.index[~covered]]}
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
                    p = sub[["date", "symbol", "buy", "est_cost_bps", f"arm_{a}", f"fwd_{h}"]].rename(columns={f"arm_{a}": "score", f"fwd_{h}": "fwd"})
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
    f = lambda x, fmt: "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else format(x, fmt)
    print(f"accuracy scorecard since {out['since']}  calls={out['calls']}  sessions={out['sessions']}  "
          f"(retrospective; the frozen forward test {out['forward_test_protocol_hash']} is the arbiter)")
    print(f"floor Rs {floor / 1e7:.0f}cr ADT | hit = beat the equal-weight universe mean after 0.50% | lift = hit - random pick")
    print(f"{'arm':>17} {'tier':>9} {'h':>3} {'regime':>6} {'dates':>5} {'eff':>5} {'IC':>7} {'IC_t':>6} {'hit':>6} "
          f"{'base':>6} {'lift':>7} {'+-95':>6} {'ex@.30':>7} {'ex@.50':>7} {'t_eff':>6} {'payoff':>6} {'turn':>5}  flag  "
          f"| own cost: {'ex@own':>7} {'ex@.30':>7} {'calls':>6} {'null':>6} {'eff':>5}")
    for r in out["rows"]:
        if r["floor"] != floor or r["tier"] not in tiers:
            continue
        print(f"{r['arm']:>17} {str(r['tier']):>9} {r['horizon']:>3} {r['regime']:>6} {r['dates']:>5} {r['eff_dates']:5.1f} "
              f"{f(r['rank_ic'], '+7.3f'):>7} {f(r['ic_t_eff'], '6.2f'):>6} {f(r['hit_rate'], '6.3f'):>6} "
              f"{f(r['base_hit'], '6.3f'):>6} {f(r['hit_lift'], '+7.3f'):>7} {f(r['hit_ci95'], '6.3f'):>6} "
              f"{f(r['excess_030_pct'], '+7.3f'):>7} {f(r['excess_050_pct'], '+7.3f'):>7} {f(r['t_eff'], '6.2f'):>6} "
              f"{f(r['payoff'], '6.2f'):>6} {f(r['turnover'], '5.2f'):>5}  {'LOW-DATA' if r['low_data'] else r['verdict']}  "
              f"| {f(r['excess_own_pct'], '+7.3f'):>7} {f(r['excess_030_same_rows_pct'], '+7.3f'):>7} {r['own_cost_calls']:>6} "
              f"{r['own_cost_missing']:>6} {r['own_cost_eff_dates']:5.1f}")
    for h, c in out["calibration"].items():
        if c["n"]:
            print(f"calibration {h}d: n={c['n']} mean predicted {c['mean_predicted']:.3f} vs decisive-WIN base {c['base_rate']:.3f}; "
                  f"Brier {c['brier']:.4f} vs hindsight base rate {c['brier_base']:.4f}")
            t = c.get("trailing") or {}
            if t.get("n"):
                ci = "LOW-DATA, no CI" if t["ci95"] is None else f"[{t['ci95'][0]:+.4f}, {t['ci95'][1]:+.4f}]"
                print(f"  vs trailing {t['window']}-date base (purged {t['purge_dates']}): n={t['n']} dates={t['dates']} "
                      f"dBrier {t['diff']:+.4f} {ci}")


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
