"""Measure two candidate plan rules before any of them changes a score or publishes an exit call.

AF-20261117-14 (events, owner decision 2026-11-18: tag now, measure before any penalty)
    Do published Buy calls whose holding window contains a corporate-action ex-date or the monthly
    F&O expiry (the events planEvents.ts now tags) earn a different net excess, or carry more
    dispersion, than same-date Buy calls without one?

AF-20261117-16 (exits, owner decision 2026-11-18: measure first, publish only if it beats holding)
    When a published Buy is re-ranked out of Buy/Strong Buy inside its window, does exiting at the
    next open beat holding to the horizon?

Method (forward_test_report.py's conventions, reused rather than re-derived):
  * calls: unified_recommendations_history, the latest call per symbol published before the entry open;
  * entry the next session's open, exit H sessions later at the open; liquid universe (>= Rs 1cr ADT),
    forward returns winsorised per date, 25 bps per side;
  * every comparison is paired WITHIN a date (rule A minus rule B on the same session), averaged per date,
    and its t uses dates / H independent windows -- overlapping windows are not independent samples;
  * fewer than MIN_DATES_RELIABLE independent windows is LOW-DATA, not evidence either way.
F&O membership is point in time (fno_universe_asof). Expiry is the last Tuesday of the month from
2025-09 (NSE moved expiry to Tuesday), the last Thursday before; holiday shifts are not modelled.

Usage (from src/server):
    python plan_rule_measure.py --rule events   [--since 2026-09-01] [--horizon 5] [--json]
    python plan_rule_measure.py --rule downgrade [--since 2026-09-01] [--horizon 5] [--json]
"""
from __future__ import annotations

import argparse
import datetime
import json
import math

import numpy as np
import pandas as pd

from db_compat import connect
from factor_edge import MIN_DATES_RELIABLE, _effective_dates
from forward_test_report import PROTOCOL, build_panel, latest_call_per_session, load_calls, load_sessions

BUY = ("Buy", "Strong Buy")
TUESDAY_EXPIRY_FROM = datetime.date(2025, 9, 1)


def monthly_expiry(year: int, month: int) -> datetime.date:
    """Last Tuesday (from 2025-09) or last Thursday (before) of the month."""
    weekday = 1 if datetime.date(year, month, 1) >= TUESDAY_EXPIRY_FROM else 3
    nxt = datetime.date(year + month // 12, month % 12 + 1, 1)
    last = nxt - datetime.timedelta(days=1)
    return last - datetime.timedelta(days=(last.weekday() - weekday) % 7)


def load_ex_dates(con, since: str) -> dict[str, list[datetime.date]]:
    """Corporate-action ex-dates per symbol on/after `since`. record_date is a DATE column, so it is compared as
    ISO text (LIKE/substring on a DATE raises in Postgres; AF-20261117-14 review)."""
    out: dict[str, list[datetime.date]] = {}
    for sym, d in con.execute(
            "SELECT symbol, record_date::text FROM stock_corporate_action_history "
            "WHERE record_date IS NOT NULL AND record_date::text >= ?", (since,)).fetchall():
        out.setdefault(sym, []).append(datetime.date.fromisoformat(str(d)[:10]))
    return out


def holding_window(sessions: pd.DatetimeIndex, session: pd.Timestamp, horizon: int):
    """(entry session, exit session) for a call on `session`: entry next open, exit H sessions later."""
    i = sessions.get_loc(session)
    if i + 1 + horizon >= len(sessions):
        return None
    return sessions[i + 1], sessions[i + 1 + horizon]


def paired_by_date(a: pd.DataFrame, value: str, flag: str, horizon: int) -> dict:
    """Mean over dates of (mean `value` where flag) - (mean `value` where not flag), same date only."""
    per_date = []
    for _, g in a.groupby("date"):
        on, off = g[g[flag]], g[~g[flag]]
        if len(on) and len(off):
            per_date.append(float(on[value].mean() - off[value].mean()))
    return summarise(per_date, horizon)


def summarise(per_date: list[float], horizon: int) -> dict:
    dates = len(per_date)
    if dates == 0:
        return {"dates": 0, "eff_dates": 0.0, "mean_pct": float("nan"), "t_eff": float("nan"), "verdict": "LOW-DATA"}
    x = np.array(per_date)
    eff = _effective_dates(dates, horizon)
    sd = x.std(ddof=1) if dates > 1 else float("nan")
    t = float(x.mean() / (sd / math.sqrt(max(eff, 1.0)))) if sd == sd and sd > 1e-12 else float("nan")
    if eff < MIN_DATES_RELIABLE:
        verdict = "LOW-DATA"
    elif t == t and abs(t) >= 2:
        verdict = "DIFFERENT"
    else:
        verdict = "NO DIFFERENCE"
    return {"dates": dates, "eff_dates": float(eff), "mean_pct": float(x.mean() * 100), "t_eff": t, "verdict": verdict}


def flag_events(buys: pd.DataFrame, sessions: pd.DatetimeIndex, horizon: int,
                ex_dates: dict[str, list[datetime.date]], fno_by_date) -> pd.DataFrame:
    """Adds has_exdate / has_expiry: the event falls inside (entry session, exit session]."""
    out = buys.copy()
    ex, exp = [], []
    for sym, d in zip(out["symbol"], out["date"]):
        w = holding_window(sessions, d, horizon)
        if w is None:
            ex.append(False); exp.append(False); continue
        lo, hi = w[0].date(), w[1].date()
        ex.append(any(lo <= e <= hi for e in ex_dates.get(sym, ())))
        months = {(lo.year, lo.month), (hi.year, hi.month)}
        expiries = [monthly_expiry(y, m) for y, m in months]
        exp.append(sym in fno_by_date(d) and any(lo <= e <= hi for e in expiries))
    out["has_exdate"] = ex
    out["has_expiry"] = exp
    return out


def downgrade_effect(buys: pd.DataFrame, cls: dict, opens: dict, sessions: pd.DatetimeIndex,
                     horizon: int, cost: float) -> pd.DataFrame:
    """Per Buy call downgraded inside its window: exit-at-next-open return minus hold return.

    `cls[(symbol, session)]` is the classification of the latest call for that session; a session with
    no call is no information, not a downgrade. `opens[(symbol, session)]` is that session's open.
    Both rules pay the same round trip, so `cost` cancels in the difference; it is kept on each leg
    so the per-leg returns read as net figures."""
    rows = []
    for sym, d in zip(buys["symbol"], buys["date"]):
        i = sessions.get_loc(d)
        if i + 1 + horizon >= len(sessions):
            continue
        entry = opens.get((sym, sessions[i + 1]))
        hold_exit = opens.get((sym, sessions[i + 1 + horizon]))
        if not entry or not hold_exit:
            continue
        for k in range(i + 1, i + horizon):
            c = cls.get((sym, sessions[k]))
            if c is not None and c not in BUY:
                early = opens.get((sym, sessions[k + 1]))
                if early:
                    rows.append({"date": d, "symbol": sym, "downgraded_to": c,
                                 "exit_ret": early / entry - 1 - cost, "hold_ret": hold_exit / entry - 1 - cost})
                break
    out = pd.DataFrame(rows, columns=["date", "symbol", "downgraded_to", "exit_ret", "hold_ret"])
    out["diff"] = out["exit_ret"] - out["hold_ret"]
    return out


def _load(con, since: str, horizon: int):
    sessions = load_sessions(con)
    calls = latest_call_per_session(load_calls(con, since), sessions)
    calls = calls[calls["session"] >= pd.Timestamp(since)]
    panel = build_panel(con, calls, sessions, [horizon], PROTOCOL["min_adt"])
    cost = 2 * PROTOCOL["cost_per_side"]
    panel["excess"] = panel[f"fwd_{horizon}"] - cost - panel.groupby("date")[f"fwd_{horizon}"].transform("mean")
    return sessions, calls, panel, cost


def run_events(con, since: str, horizon: int) -> dict:
    from fno_universe_asof import fno_eligible_asof
    sessions, _, panel, _ = _load(con, since, horizon)
    buys = panel[panel["classification"].isin(BUY)]
    ex_dates = load_ex_dates(con, since)
    cache: dict = {}
    fno = lambda d: cache.setdefault(d, fno_eligible_asof(con, d.strftime("%Y-%m-%d")))
    flagged = flag_events(buys, sessions, horizon, ex_dates, fno)
    flagged["abs_excess"] = flagged["excess"].abs()
    out = {}
    for flag in ("has_exdate", "has_expiry"):
        out[flag] = {
            "calls_with_event": int(flagged[flag].sum()),
            "net_excess_diff": paired_by_date(flagged, "excess", flag, horizon),
            "dispersion_diff": paired_by_date(flagged, "abs_excess", flag, horizon),
        }
    return {"rule": "events", "since": since, "horizon": horizon, "buy_calls": int(len(buys)), "results": out}


def run_downgrade(con, since: str, horizon: int) -> dict:
    sessions, calls, panel, cost = _load(con, since, horizon)
    buys = panel[panel["classification"].isin(BUY)]
    cls = {(s, d): c for s, d, c in zip(calls["symbol"], calls["session"], calls["classification"])}
    rows = con.execute("SELECT symbol, date, open FROM stock_ohlcv WHERE date >= ? "
                       "AND (is_suspect IS NULL OR is_suspect = 0)", (since,)).fetchall()
    opens = {(s, pd.Timestamp(d)): float(o) for s, d, o in rows if o}
    eff = downgrade_effect(buys, cls, opens, sessions, horizon, cost)
    per_date = eff.groupby("date")["diff"].mean().tolist()
    return {"rule": "downgrade", "since": since, "horizon": horizon, "buy_calls": int(len(buys)),
            "downgraded_calls": int(len(eff)),
            "by_target": eff["downgraded_to"].value_counts().to_dict(),
            "exit_minus_hold": summarise(per_date, horizon),
            "note": "mean_pct > 0 with verdict DIFFERENT means exiting on the downgrade beat holding"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--rule", choices=["events", "downgrade"], required=True)
    ap.add_argument("--since", default="2026-09-01")
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    con = connect()
    try:
        res = (run_events if a.rule == "events" else run_downgrade)(con, a.since, a.horizon)
    finally:
        con.close()
    print(json.dumps(res, indent=2 if not a.json else None, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
