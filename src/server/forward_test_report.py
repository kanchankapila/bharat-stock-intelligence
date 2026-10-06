"""Frozen forward test and selective-accuracy report for the published ranking.

Question answered: of the calls the platform publishes at a given COVERAGE (top 1% ... 100% of the ranked
liquid universe by `unified_score`), how often did they beat the equal-weight universe after costs, and how
sure can we be? Accuracy is reported per coverage tier because a model that is right 60% of the time on 5% of
names is more useful than one that is 52% right on everything, and the platform should be able to say "no call".

What makes the number honest (each is a rule in PROTOCOL below, frozen in app_settings so it cannot drift):
  * calls come from `unified_recommendations_history` (append-only, PK symbol+generated_at), and each symbol's
    LATEST call published before the entry open is the call -- nothing generated after entry can leak in;
  * entry is the NEXT session's open, exit N sessions later at the open (measurement.md panel spec);
  * universe is liquid names only (>= Rs 1cr trailing-20d ADT), forward returns winsorised per date;
  * 25 bps per side is charged to every call; the benchmark is the equal-weight mean of the same universe;
  * uncertainty uses dates / horizon independent windows (factor_edge._effective_dates), never the raw row count;
  * a tier with fewer than MIN_DATES_RELIABLE independent windows is LOW-DATA and is not evidence either way.

Usage (from src/server):
    python forward_test_report.py                 # forward test since the protocol start date
    python forward_test_report.py --retro 2026-09-28   # also print a RETROSPECTIVE block (not the forward test)
    python forward_test_report.py --persist       # also store the result in app_settings['forward_test_report']
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import sys

import numpy as np
import pandas as pd

from factor_edge import MIN_DATES_RELIABLE, _effective_dates, _forward_returns
from db_compat import connect

PROTOCOL = {
    "version": 1,
    "start_date": "2026-10-06",
    "source": "unified_recommendations_history, latest call per symbol published before the entry open",
    "score": "unified_score",
    "entry": "next session open",
    "exit": "open N sessions after entry",
    "horizons": [5, 10, 21],
    "tiers": [0.01, 0.02, 0.05, 0.10, 0.25, 0.50, 1.00],
    "universe": "ranked names with >= Rs 1cr trailing-20d ADT",
    "min_adt": 10_000_000,
    "cost_per_side": 0.0025,
    "benchmark": "equal-weight mean of the same universe on the same dates",
    "winsorise": "per date 1/99 percentile (quantile 'higher' low cut, 'lower' high cut)",
    "uncertainty": "dates / horizon independent windows; LOW-DATA below MIN_DATES_RELIABLE",
}
PROTOCOL_KEY = "forward_test_protocol"
REPORT_KEY = "forward_test_report"
_OPEN = datetime.time(9, 15)


def protocol_hash(protocol: dict) -> str:
    return hashlib.sha256(json.dumps(protocol, sort_keys=True).encode()).hexdigest()[:16]


def call_session(ts: pd.Timestamp, sessions: pd.DatetimeIndex):
    """The trading session a published call belongs to (entry is the NEXT session's open).

    A call published before 09:15 IST on a day is knowable for that day's open, so it belongs to the
    PREVIOUS session; a post-close, intraday or weekend publication belongs to the latest session on or
    before its date. Returns NaT when it predates every known session."""
    t = ts.tz_convert("Asia/Kolkata")
    d = pd.Timestamp(t.date())
    if t.time() < _OPEN:
        d -= pd.Timedelta(days=1)
    i = sessions.searchsorted(d, side="right") - 1
    return sessions[i] if i >= 0 else pd.NaT


def latest_call_per_session(calls: pd.DataFrame, sessions: pd.DatetimeIndex) -> pd.DataFrame:
    out = calls.copy()
    out["session"] = [call_session(t, sessions) for t in out["generated_at"]]
    out = out.dropna(subset=["session"]).sort_values("generated_at")
    return out.drop_duplicates(["symbol", "session"], keep="last").reset_index(drop=True)


def apply_protocol_start(calls: pd.DataFrame, start: str) -> pd.DataFrame:
    return calls[calls["session"] >= pd.Timestamp(start)].reset_index(drop=True)


def _aggregate(per_date: list[tuple[float, float, float, int]], horizon: int, tier, coverage) -> dict:
    """per_date rows are (net excess fraction, hit rate, base hit rate, calls)."""
    if not per_date:
        return {"tier": tier, "coverage_pct": coverage, "calls_per_date": 0.0, "dates": 0, "eff_dates": 0.0,
                "hit_rate": float("nan"), "base_hit": float("nan"), "hit_lift": float("nan"),
                "hit_ci95": float("nan"), "mean_excess_pct": float("nan"), "t_eff": float("nan"),
                "verdict": "LOW-DATA"}
    ex = np.array([r[0] for r in per_date]); hit = np.array([r[1] for r in per_date])
    base = np.array([r[2] for r in per_date]); calls = np.array([r[3] for r in per_date])
    dates = len(per_date)
    eff = _effective_dates(dates, horizon)
    root = math.sqrt(max(eff, 1.0))
    sd = ex.std(ddof=1) if dates > 1 else float("nan")
    t_eff = float(ex.mean() / (sd / root)) if sd == sd and sd > 1e-12 else float("nan")   # zero variance (hold-everything: excess == -cost every date) is not a t-stat
    ci = float(1.96 * hit.std(ddof=1) / root) if dates > 1 else float("nan")
    lift = float(hit.mean() - base.mean())
    if eff < MIN_DATES_RELIABLE:
        verdict = "LOW-DATA"
    elif t_eff == t_eff and t_eff >= 2 and ci == ci and lift - ci > 0:
        verdict = "EDGE"
    elif t_eff == t_eff and t_eff <= -2:
        verdict = "NEGATIVE"
    else:
        verdict = "NO EDGE"
    return {"tier": tier, "coverage_pct": coverage, "calls_per_date": float(calls.mean()), "dates": dates,
            "eff_dates": float(eff), "hit_rate": float(hit.mean()), "base_hit": float(base.mean()),
            "hit_lift": lift, "hit_ci95": ci, "mean_excess_pct": float(ex.mean() * 100),
            "t_eff": t_eff, "verdict": verdict}


def selective_accuracy(panel: pd.DataFrame, horizon: int, tiers=PROTOCOL["tiers"], cost: float = 0.0,
                       min_per_date: int = 30, flag_col: str | None = None) -> list[dict]:
    """Hit rate and net excess of the top-`tier` share of each date's ranked universe.

    `panel` has date, symbol, score, fwd (forward return as a fraction). A call "hits" when its forward
    return minus `cost` beats that date's equal-weight universe mean; `base_hit` is the same statistic for a
    random pick, so `hit_lift` is accuracy above chance (right-skewed returns put chance below 50%).
    With `flag_col`, the selection is the rows where that column is truthy (the calls as published)."""
    d = panel.dropna(subset=["score", "fwd"])
    groups = [g for _, g in d.groupby("date") if len(g) >= min_per_date]
    specs = [("published", None)] if flag_col else [(t, t) for t in tiers]
    out = []
    for label, q in specs:
        per_date = []
        for g in groups:
            u = g["fwd"].mean()
            net = g["fwd"] - cost
            base = float((net > u).mean())
            if flag_col:
                sel = g[g[flag_col].astype(bool)]
                if sel.empty:
                    continue
            else:
                k = max(1, math.ceil(q * len(g)))
                sel = g.sort_values("score", ascending=False, kind="stable").head(k)
            per_date.append((float(sel["fwd"].mean() - cost - u), float(((sel["fwd"] - cost) > u).mean()), base, len(sel)))
        cov = None if flag_col else round(q * 100, 2)
        out.append(_aggregate(per_date, horizon, label, cov))
    return out


def _winsorise(s: pd.Series) -> pd.Series:
    lo, hi = s.quantile(0.01, interpolation="higher"), s.quantile(0.99, interpolation="lower")
    return s.clip(lo, hi)


def build_panel(con, calls: pd.DataFrame, sessions: pd.DatetimeIndex, horizons, min_adt: float) -> pd.DataFrame:
    """calls (symbol, session, unified_score, classification) joined to open-entry forward returns and ADT."""
    start = (calls["session"].min() - pd.Timedelta(days=45)).strftime("%Y-%m-%d")
    oh = _forward_returns(con, start, horizons, entry="open")
    vol = pd.DataFrame(con.execute(
        "SELECT symbol, date, close AS c, volume AS v FROM stock_ohlcv WHERE date >= ? AND (is_suspect IS NULL OR is_suspect = 0)",
        (start,)).fetchall(), columns=["symbol", "date", "c", "v"])
    vol["date"] = pd.to_datetime(vol["date"])
    vol["dv"] = pd.to_numeric(vol["c"], errors="coerce") * pd.to_numeric(vol["v"], errors="coerce")
    vol = vol.sort_values(["symbol", "date"])
    vol["adt"] = vol.groupby("symbol")["dv"].transform(lambda s: s.rolling(20, min_periods=15).mean())
    m = calls.merge(oh[["symbol", "date"] + [f"fwd_{h}" for h in horizons]], left_on=["symbol", "session"],
                    right_on=["symbol", "date"], how="inner").drop(columns=["date"])
    m = m.merge(vol[["symbol", "date", "adt"]], left_on=["symbol", "session"], right_on=["symbol", "date"], how="left")
    m = m.drop(columns=["date"])
    m = m[m["adt"] >= min_adt].rename(columns={"session": "date"})
    for h in horizons:
        m[f"fwd_{h}"] = m.groupby("date")[f"fwd_{h}"].transform(_winsorise)
    return m


def load_calls(con, since: str) -> pd.DataFrame:
    lo = (pd.Timestamp(since) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    rows = con.execute(
        "SELECT symbol, generated_at, unified_score, classification FROM unified_recommendations_history "
        "WHERE generated_at >= ? AND unified_score IS NOT NULL", (lo,)).fetchall()
    df = pd.DataFrame(rows, columns=["symbol", "generated_at", "unified_score", "classification"])
    df["generated_at"] = pd.to_datetime(df["generated_at"], utc=True).dt.tz_convert("Asia/Kolkata")
    df["unified_score"] = pd.to_numeric(df["unified_score"], errors="coerce")
    return df


def load_sessions(con) -> pd.DatetimeIndex:
    rows = con.execute("SELECT DISTINCT date FROM stock_ohlcv WHERE symbol = 'NIFTY50' ORDER BY date").fetchall()
    return pd.DatetimeIndex(pd.to_datetime([r[0] for r in rows]))


def ensure_protocol(con) -> tuple[str, bool]:
    """Freeze the protocol on first run; afterwards report whether this code still matches it."""
    h = protocol_hash(PROTOCOL)
    row = con.execute("SELECT value FROM app_settings WHERE key = ?", (PROTOCOL_KEY,)).fetchone()
    if row is None:
        con.execute("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
                    (PROTOCOL_KEY, json.dumps({"hash": h, "protocol": PROTOCOL}, sort_keys=True)))
        con.commit()
        return h, True
    return h, json.loads(row[0])["hash"] == h


def run(since: str, retro: str | None, as_json: bool, persist: bool) -> int:
    con = connect()
    h, same = ensure_protocol(con)
    if not same:
        print(f"[forward_test] PROTOCOL DRIFT: code hash {h} differs from the frozen protocol in app_settings."
              " Results are NOT comparable with earlier runs; change PROTOCOL only by starting a new version.",
              file=sys.stderr)
        con.close()
        return 2
    sessions = load_sessions(con)
    blocks = {}
    for name, start in (("forward", since), ("retrospective", retro)):
        if not start:
            continue
        calls = apply_protocol_start(latest_call_per_session(load_calls(con, start), sessions), start)
        if calls.empty:
            blocks[name] = {"since": start, "calls": 0, "tiers": {}}
            continue
        panel = build_panel(con, calls, sessions, PROTOCOL["horizons"], PROTOCOL["min_adt"])
        res = {}
        for hz in PROTOCOL["horizons"]:
            p = panel.rename(columns={"unified_score": "score", f"fwd_{hz}": "fwd"})
            p["buy"] = p["classification"].isin(["Buy", "Strong Buy"])
            res[str(hz)] = selective_accuracy(p, hz, cost=2 * PROTOCOL["cost_per_side"])
            res[str(hz)] += selective_accuracy(p, hz, cost=2 * PROTOCOL["cost_per_side"], flag_col="buy")
        blocks[name] = {"since": start, "calls": int(len(calls)), "sessions": int(calls["session"].nunique()), "tiers": res}
    out = {"protocol_hash": h, "generated_at": datetime.datetime.now().isoformat(timespec="seconds"), "blocks": blocks}
    if as_json:
        print(json.dumps(out, indent=2, default=str))
    else:
        for name, b in blocks.items():
            label = "FORWARD TEST (frozen protocol)" if name == "forward" else "RETROSPECTIVE (informational, NOT the forward test)"
            print(f"\n{'=' * 100}\n{label}  since {b['since']}  calls={b['calls']}  sessions={b.get('sessions', 0)}\n{'=' * 100}")
            for hz, rows in b["tiers"].items():
                print(f"\n  horizon {hz}d | 25bps/side charged | benchmark = equal-weight ranked liquid universe")
                print(f"  {'tier':>10} {'cover%':>7} {'calls/d':>8} {'dates':>6} {'eff':>6} {'hit':>7} {'base':>7} {'lift':>7} "
                      f"{'+-95%':>7} {'excess%':>8} {'t_eff':>6}  verdict")
                for r in rows:
                    f = lambda x, fmt: "n/a" if x != x else format(x, fmt)
                    print(f"  {str(r['tier']):>10} {str(r['coverage_pct'] if r['coverage_pct'] is not None else 'pub'):>7} "
                          f"{r['calls_per_date']:8.1f} {r['dates']:6d} {r['eff_dates']:6.1f} {f(r['hit_rate'], '7.3f'):>7} "
                          f"{f(r['base_hit'], '7.3f'):>7} {f(r['hit_lift'], '+7.3f'):>7} {f(r['hit_ci95'], '7.3f'):>7} "
                          f"{f(r['mean_excess_pct'], '+8.3f'):>8} {f(r['t_eff'], '6.2f'):>6}  {r['verdict']}")
        print("\nNothing with eff < %d independent windows is evidence of anything. 'hit' = beat the universe mean after costs; "
              "'lift' = hit minus a random pick's hit rate." % MIN_DATES_RELIABLE)
    if persist:
        con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                    'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                    (REPORT_KEY, json.dumps(out, default=str)))
        con.commit()
    con.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default=PROTOCOL["start_date"])
    ap.add_argument("--retro", help="also print a retrospective block from this date (informational)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--persist", action="store_true")
    a = ap.parse_args()
    if pd.Timestamp(a.since) < pd.Timestamp(PROTOCOL["start_date"]):
        ap.error(f"--since may not predate the frozen protocol start {PROTOCOL['start_date']}; use --retro for earlier history")
    return run(a.since, a.retro, a.json, a.persist)


if __name__ == "__main__":
    sys.exit(main())
