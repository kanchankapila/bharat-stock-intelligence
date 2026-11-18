"""Frozen forward test of the MarketsMojo financial-trend score (AF-20261019-02).

The 2026-11-18 retrospective read an edge (rank IC 0.05 at 21 sessions, a top-50 book +0.9% a
period net, two thirds of it surviving a momentum/volatility control), but the history is a vendor
backfill fetched in 2026-08, so past scores may carry later restatements. This test grades only
what the platform actually knew: on each session from the start date, a symbol's score is its
newest row whose CAPTURE date (`fetched_at`, written by the weekly marketsmojo_fintrend_fetcher)
is on or before that session, so nothing restated afterwards can leak in. Returns come after the
next open. Nothing here touches the ranker; the decision rule in PROTOCOL is fixed in advance.

The machinery (panel, liquidity floor, winsorising, costs, independent-window uncertainty,
verdicts) is forward_test_report.py's, so the two forward tests read the same way.

Usage (from src/server):
    python fintrend_forward_test.py             # print the forward test
    python fintrend_forward_test.py --persist   # also store it in app_settings['fintrend_forward_test_report']
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys

import pandas as pd

from db_compat import connect
from factor_edge import MIN_DATES_RELIABLE
from forward_test_report import build_panel, ensure_protocol, load_sessions, selective_accuracy

PROTOCOL = {
    "version": 1,
    "start_date": "2026-11-18",
    "source": "marketsmojo_fintrend_history; per session, each symbol's newest score captured "
              "(fetched_at) on or before the session, score dated at most max_score_age_days earlier",
    "score": "score (MarketsMojo financial-trend points, about -50 to +50, higher = stronger)",
    "max_score_age_days": 100,
    "entry": "next session open",
    "exit": "open N sessions after entry",
    "horizons": [5, 21],
    "tiers": [0.03, 0.10, 0.25, 0.50, 1.00],
    "tie_break": "within a date, equal scores ordered by symbol",
    "universe": "scored names with >= Rs 1cr trailing-20d ADT",
    "min_adt": 10_000_000,
    "cost_per_side": 0.0025,
    "cost_basis": "one round trip per 63-session re-score cycle: charge = 2 * cost_per_side * horizon / 63",
    "benchmark": "equal-weight mean of the scored liquid universe on the same dates",
    "winsorise": "per date 1/99 percentile (forward_test_report._winsorise)",
    "uncertainty": "dates / horizon independent windows; LOW-DATA below MIN_DATES_RELIABLE",
    "decision": "wiring candidate only when the 0.03 tier reads EDGE at 5 sessions and is not NEGATIVE at "
                "21; NEGATIVE at the 0.03 tier at either horizon retires it; otherwise it keeps accumulating. "
                "Earliest verdict: 100 sessions after the start (about 2027-04).",
}
PROTOCOL_KEY = "fintrend_forward_test_protocol"
REPORT_KEY = "fintrend_forward_test_report"


def cost_for(horizon: int) -> float:
    """The score changes about once a quarter, so a full round trip every window overstates cost."""
    return 2 * PROTOCOL["cost_per_side"] * horizon / 63


def calls_as_known(scores: pd.DataFrame, sessions: pd.DatetimeIndex, start: str, max_age_days: int) -> pd.DataFrame:
    """scores: symbol, sdate, known, score. One row per (symbol, session): the newest score dated on or
    before the session, no older than max_age_days, and captured (known) on or before the session."""
    age = pd.Timedelta(days=max_age_days)
    out = []
    for s in sessions[sessions >= pd.Timestamp(start)]:
        k = scores[(scores["known"] <= s) & (scores["sdate"] <= s) & (scores["sdate"] >= s - age)]
        if not k.empty:
            out.append(k.sort_values("sdate").drop_duplicates("symbol", keep="last").assign(session=s))
    if not out:
        return pd.DataFrame(columns=["symbol", "session", "score"])
    return pd.concat(out, ignore_index=True)[["symbol", "session", "score"]]


def load_scores(con) -> pd.DataFrame:
    rows = con.execute("SELECT symbol, date AS sdate, fetched_at AS known, score::float8 AS score "
                       "FROM marketsmojo_fintrend_history WHERE score IS NOT NULL AND fetched_at IS NOT NULL").fetchall()
    df = pd.DataFrame([tuple(r) for r in rows], columns=["symbol", "sdate", "known", "score"])
    df["sdate"] = pd.to_datetime(df["sdate"])
    df["known"] = pd.to_datetime(df["known"].astype(str).str[:10])
    return df


def run(as_json: bool, persist: bool) -> int:
    con = connect()
    h, same = ensure_protocol(con, PROTOCOL_KEY, PROTOCOL)
    if not same:
        print(f"[fintrend_forward_test] PROTOCOL DRIFT: code hash {h} differs from the frozen protocol. "
              "Change PROTOCOL only by starting a new version.", file=sys.stderr)
        con.close()
        return 2
    sessions = load_sessions(con)
    calls = calls_as_known(load_scores(con), sessions, PROTOCOL["start_date"], PROTOCOL["max_score_age_days"])
    res = {}
    if not calls.empty:
        panel = build_panel(con, calls, sessions, PROTOCOL["horizons"], PROTOCOL["min_adt"])
        panel = panel.sort_values(["date", "symbol"], kind="stable")   # selective_accuracy's stable sort keeps this on ties
        for hz in PROTOCOL["horizons"]:
            p = panel.rename(columns={f"fwd_{hz}": "fwd"})
            res[str(hz)] = selective_accuracy(p, hz, tiers=PROTOCOL["tiers"], cost=cost_for(hz))
    out = {"protocol_hash": h, "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
           "since": PROTOCOL["start_date"], "calls": int(len(calls)),
           "sessions": int(calls["session"].nunique()) if len(calls) else 0, "tiers": res}
    if as_json:
        print(json.dumps(out, indent=2, default=str))
    else:
        print(f"FINTREND FORWARD TEST (frozen {h}) since {out['since']}  calls={out['calls']}  sessions={out['sessions']}")
        for hz, rows in res.items():
            for r in rows:
                print(f"  {hz:>3}d tier {r['tier']:<5} dates {r['dates']:4d} eff {r['eff_dates']:5.1f} "
                      f"excess% {r['mean_excess_pct']:+.3f} t {r['t_eff']:.2f}  {r['verdict']}")
        print(f"Nothing with eff < {MIN_DATES_RELIABLE} independent windows is evidence. Decision: {PROTOCOL['decision']}")
    if persist:
        con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                    'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                    (REPORT_KEY, json.dumps(out, default=str)))
        con.commit()
    con.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--persist", action="store_true")
    a = ap.parse_args()
    return run(a.json, a.persist)


if __name__ == "__main__":
    sys.exit(main())
